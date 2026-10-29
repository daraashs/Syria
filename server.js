import express from 'express';
import pg from 'pg';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nameKey, CATEGORIES, GOVERNORATES } from './lib/arabic.js';
import { hashPassword, verifyPassword, sha256, randomCode, randomToken } from './lib/auth.js';
import { sendCode } from './lib/mail.js';
import { csvLine, labelFor, formatCell } from './lib/csv.js';
import { storeImage, removeImage, storageEnabled } from './lib/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = 20;
const SESSION_DAYS = 30;
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const STATUS_VALUES = ['pending', 'approved', 'rejected', 'merged'];
const DEFAULT_BANNER =
  'منصة توثيقية لذوي الشهداء والمفقودين والمعتقلين في حرب سوريا.\n' +
  'لتسجيل حالة: أنشئ حساباً بريدك الإلكتروني، وأكد البريد برمز يصلك، ثم أدخل الاسم الكامل مع التاريخ والمكان.\n' +
  'تُراجع كل حالة قبل نشرها، ولا تظهر بيانات التواصل للعامة.';

const PUBLIC_COLUMNS = ['id', 'category', 'status', 'full_name', 'event_date', 'governorate',
  'city', 'area', 'place_of_detention', 'notes'];
const ADMIN_COLUMNS = [...PUBLIC_COLUMNS, 'review_status', 'contact', 'submitter_email', 'created_at'];
const EXPR = {
  event_date: "to_char(r.event_date, 'YYYY-MM-DD')",
  created_at: "to_char(r.created_at, 'YYYY-MM-DD')",
  submitter_email: 'u.email',
};

if (!process.env.DATABASE_URL) {
  console.error('متغير DATABASE_URL غير موجود. انسخه من ملف .env.example');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
});

// ---------- أدوات مساعدة ----------

const clean = (value, max = 200) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const today = () => new Date().toISOString().slice(0, 10);
const normEmail = (v) => clean(v, 254).toLowerCase();
const fail = (res, message, status = 400) => res.status(status).json({ error: message });

// يغلف مسارات async ويحوّل أخطاء قاعدة البيانات إلى رسائل مفهومة
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(err);
    if (err.code === '23505') return fail(res, 'هذا الاسم مسجّل مسبقاً من قبلك في هذه الفئة', 409);
    if (err.code === '23514') return fail(res, 'بيانات غير صالحة لهذا السجل');
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'حدث خطأ في الخادم' });
  });

function getCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

const cookieString = (value, maxAge) =>
  `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${IS_PROD ? '; Secure' : ''}`;

const publicUser = (u) => ({
  id: u.id, email: u.email, display_name: u.display_name, bio: u.bio,
  avatar: u.avatar, logo: u.logo, lang: u.lang, role: u.role,
});

// قيم الصور: فارغة تعني حذف الصورة، وغير صالحة تُرفض
function imageValue(v) {
  if (!v) return { ok: true, value: null };
  if (typeof v !== 'string' || v.length > 150000 || !PHOTO_RE.test(v)) return { ok: false };
  return { ok: true, value: v };
}

// تحميل المستخدم من الجلسة (إن وُجدت)
async function loadUser(req, _res, next) {
  req.user = null;
  const token = getCookie(req.headers.cookie, 'sid');
  if (token) {
    const { rows } = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [sha256(token)]
    );
    if (rows[0] && !rows[0].blocked) req.user = rows[0];
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return fail(res, 'يجب تسجيل الدخول أولاً', 401);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return fail(res, 'غير مصرح', 403);
  next();
}

// ---------- الجلسات ورموز البريد ----------

async function startSession(res, userId) {
  const token = randomToken();
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 day'))`,
    [sha256(token), userId, SESSION_DAYS]
  );
  res.setHeader('Set-Cookie', cookieString(token, SESSION_DAYS * 86400));
}

async function userByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

async function issueCode(userId, email, purpose) {
  const code = randomCode();
  await pool.query('DELETE FROM email_codes WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
  await pool.query(
    `INSERT INTO email_codes (user_id, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes')`,
    [userId, sha256(`${userId}:${code}`), purpose]
  );
  await sendCode(email, code, purpose);
}

async function checkCode(userId, code, purpose) {
  const { rows } = await pool.query(
    `SELECT id, code_hash, attempts FROM email_codes
     WHERE user_id = $1 AND purpose = $2 AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    [userId, purpose]
  );
  const row = rows[0];
  if (!row || row.attempts >= 5) return false;
  if (row.code_hash !== sha256(`${userId}:${code}`)) {
    await pool.query('UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    return false;
  }
  await pool.query('DELETE FROM email_codes WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
  return true;
}

// حدود المحاولات: تسجيل الدخول والرموز تُحمى من التخمين
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة، حاول بعد قليل' },
});

const submitLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user ? req.user.id : req.ip}`,
  message: { error: 'تجاوزت الحد اليومي للتسجيل' },
});

// ---------- إعداد التطبيق ----------

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '300kb' }));
app.use(wrap(loadUser));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- الحسابات ----------

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const password = String(req.body.password || '');
  const name = clean(req.body.display_name, 80);
  if (!EMAIL_RE.test(email)) return fail(res, 'البريد الإلكتروني غير صحيح');
  if (password.length < 8) return fail(res, 'كلمة المرور يجب ألا تقل عن 8 أحرف');
  if (name.length < 2) return fail(res, 'يرجى كتابة الاسم');

  const existing = await userByEmail(email);
  if (existing && existing.email_verified) {
    return fail(res, 'البريد مسجّل مسبقاً، يرجى تسجيل الدخول', 409);
  }
  let userId;
  if (existing) {
    // حساب لم يُؤكَّد بعد: نحدّث بياناته ونعيد الإرسال
    userId = existing.id;
    await pool.query('UPDATE users SET password_hash = $2, display_name = $3 WHERE id = $1',
      [userId, hashPassword(password), name]);
  } else {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
      [email, hashPassword(password), name]
    );
    userId = rows[0].id;
  }
  await issueCode(userId, email, 'verify');
  res.json({ ok: true, message: 'أرسلنا رمز التحقق إلى بريدك الإلكتروني' });
}));

app.post('/api/auth/verify', authLimiter, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const code = String(req.body.code || '').trim();
  const user = await userByEmail(email);
  if (!user || !(await checkCode(user.id, code, 'verify'))) {
    return fail(res, 'الرمز غير صحيح أو انتهت صلاحيته');
  }
  const role = email === ADMIN_EMAIL ? 'admin' : user.role;
  await pool.query('UPDATE users SET email_verified = TRUE, role = $2 WHERE id = $1', [user.id, role]);
  await startSession(res, user.id);
  res.json({ ok: true });
}));

app.post('/api/auth/resend', authLimiter, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const user = await userByEmail(email);
  if (user && !user.email_verified) await issueCode(user.id, email, 'verify');
  res.json({ ok: true });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const user = await userByEmail(email);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return fail(res, 'البريد أو كلمة المرور غير صحيحة', 401);
  }
  if (!user.email_verified) {
    return res.status(403).json({ error: 'يجب تأكيد البريد الإلكتروني أولاً', needs_verification: true });
  }
  if (user.blocked) return fail(res, 'هذا الحساب موقوف، تواصل مع الإدارة', 403);
  if (email === ADMIN_EMAIL && user.role !== 'admin') {
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
  }
  await startSession(res, user.id);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = getCookie(req.headers.cookie, 'sid');
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.setHeader('Set-Cookie', cookieString('', 0));
  res.json({ ok: true });
}));

// استعادة كلمة المرور: الرد واحد سواء وُجد الحساب أم لا
app.post('/api/auth/forgot', authLimiter, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const user = await userByEmail(email);
  if (user && user.email_verified) await issueCode(user.id, email, 'reset');
  res.json({ ok: true });
}));

app.post('/api/auth/reset', authLimiter, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const password = String(req.body.password || '');
  if (password.length < 8) return fail(res, 'كلمة المرور يجب ألا تقل عن 8 أحرف');
  const user = await userByEmail(email);
  if (!user || !(await checkCode(user.id, String(req.body.code || '').trim(), 'reset'))) {
    return fail(res, 'الرمز غير صحيح أو انتهت صلاحيته');
  }
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, hashPassword(password)]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  res.json({ ok: true });
}));

// ---------- الملف الشخصي ----------

app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

app.put('/api/me', requireUser, wrap(async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const vals = [];
  const set = (column, value) => {
    vals.push(value);
    sets.push(`${column} = $${vals.length}`);
  };

  if ('display_name' in b) {
    const name = clean(b.display_name, 80);
    if (name.length < 2) return fail(res, 'الاسم قصير جداً');
    set('display_name', name);
  }
  if ('bio' in b) set('bio', clean(b.bio, 300) || null);
  if ('lang' in b) {
    if (!['ar', 'en'].includes(b.lang)) return fail(res, 'لغة غير مدعومة');
    set('lang', b.lang);
  }
  const replaced = [];
  for (const field of ['avatar', 'logo']) {
    if (field in b) {
      const img = imageValue(b[field]);
      if (!img.ok) return fail(res, 'الصورة غير صالحة أو كبيرة الحجم');
      const url = await storeImage(img.value, field === 'avatar' ? 'avatars' : 'logos');
      set(field, url);
      if (req.user[field] && req.user[field] !== url) replaced.push(req.user[field]);
    }
  }
  if (!sets.length) return fail(res, 'لا توجد بيانات للحفظ');

  vals.push(req.user.id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals
  );
  for (const old of replaced) await removeImage(old);
  res.json({ user: publicUser(rows[0]) });
}));

app.post('/api/me/password', requireUser, wrap(async (req, res) => {
  const current = String(req.body.current || '');
  const password = String(req.body.password || '');
  if (!verifyPassword(current, req.user.password_hash)) return fail(res, 'كلمة المرور الحالية غير صحيحة');
  if (password.length < 8) return fail(res, 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف');
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, hashPassword(password)]);
  res.json({ ok: true });
}));

// ---------- العامة ----------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/meta', (_req, res) => res.json({ governorates: GOVERNORATES, categories: CATEGORIES }));

app.get('/api/settings', wrap(async (_req, res) => {
  const { rows } = await pool.query("SELECT value FROM site_settings WHERE key = 'banner'");
  res.json({ banner: rows[0]?.value || DEFAULT_BANNER });
}));

app.get('/api/stats', wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT category,
      COUNT(*) FILTER (WHERE review_status = 'approved')::int AS total,
      COUNT(*) FILTER (WHERE review_status = 'approved' AND status = 'released')::int AS released,
      COUNT(*) FILTER (WHERE review_status = 'approved' AND status = 'missing')::int AS missing
    FROM records GROUP BY category`);
  const out = {
    martyr: { total: 0 },
    missing: { total: 0 },
    detainee: { total: 0, released: 0, missing: 0 },
  };
  for (const r of rows) {
    out[r.category] = r.category === 'detainee'
      ? { total: r.total, released: r.released, missing: r.missing }
      : { total: r.total };
  }
  res.json(out);
}));

// يبني شروط البحث. المسؤول يفلتر بحالة المراجعة عبر review، والعامة تُرى المعتمدة فقط
function buildFilter(q, { admin = false } = {}) {
  const params = [];
  const where = [];
  const cond = (sql, ...values) => {
    const refs = values.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    let i = 0;
    where.push(sql.replace(/\?/g, () => refs[i++]));
  };

  if (CATEGORIES.includes(q.category)) cond('r.category = ?', q.category);

  if (admin) {
    if (STATUS_VALUES.includes(q.review)) cond('r.review_status = ?', q.review);
  } else {
    where.push("r.review_status = 'approved'");
  }

  const key = nameKey(clean(q.q, 100));
  if (key) cond('(r.name_key % ? OR r.name_key LIKE ?)', key, `%${key}%`);

  const place = clean(q.place, 100).replace(/[%_\\]/g, '');
  if (place) {
    const p = `%${place}%`;
    cond('(r.governorate ILIKE ? OR r.city ILIKE ? OR r.area ILIKE ? OR r.place_of_detention ILIKE ?)', p, p, p, p);
  }

  const governorate = clean(q.governorate, 50);
  if (GOVERNORATES.includes(governorate)) cond('r.governorate = ?', governorate);

  if (q.category === 'detainee' && ['released', 'missing'].includes(q.status)) {
    cond('r.status = ?', q.status);
  }

  if (isDate(q.from)) cond('r.event_date >= ?', q.from);
  if (isDate(q.to)) cond('r.event_date <= ?', q.to);

  return { where: where.length ? where.join(' AND ') : 'TRUE', params };
}

// تصدير CSV على دفعات لتحمل ملايين السجلات دون استهلاك الذاكرة
async function streamExport(res, filename, lang, filter, columns) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.write('\uFEFF' + csvLine(columns.map((c) => labelFor(c, lang))));

  const select = columns.map((c) => `${EXPR[c] || `r.${c}`} AS ${c}`).join(', ');
  let lastId = 0;
  for (;;) {
    const params = [...filter.params, lastId];
    const { rows } = await pool.query(
      `SELECT ${select}
       FROM records r LEFT JOIN users u ON u.id = r.user_id
       WHERE ${filter.where} AND r.id > $${params.length}
       ORDER BY r.id LIMIT 1000`,
      params
    );
    if (!rows.length) break;
    for (const row of rows) {
      res.write(csvLine(columns.map((c) => formatCell(c, row[c], lang))));
    }
    lastId = rows[rows.length - 1].id;
  }
  res.end();
}

app.get('/api/records', wrap(async (req, res) => {
  if (!CATEGORIES.includes(req.query.category)) return fail(res, 'نوع غير صحيح');
  const filter = buildFilter(req.query);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM records r WHERE ${filter.where}`, filter.params
  );
  const total = countRes.rows[0].n;

  const params = [...filter.params, PAGE_SIZE, (page - 1) * PAGE_SIZE];
  const { rows } = await pool.query(
    `SELECT r.id, r.category, r.status, r.full_name,
            to_char(r.event_date, 'YYYY-MM-DD') AS event_date,
            r.governorate, r.city, r.area, r.place_of_detention, r.notes, r.photo
     FROM records r
     WHERE ${filter.where}
     ORDER BY r.event_date DESC, r.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    items: rows,
  });
}));

app.get('/api/records/export.csv', wrap(async (req, res) => {
  if (!CATEGORIES.includes(req.query.category)) return fail(res, 'نوع غير صحيح');
  const lang = req.query.lang === 'en' ? 'en' : 'ar';
  await streamExport(res, `records-${req.query.category}.csv`, lang, buildFilter(req.query), PUBLIC_COLUMNS);
}));

// التحقق من بيانات التسجيل وتنظيفها
function validateRecord(body) {
  const errors = [];
  const d = {};

  d.category = body.category;
  if (!CATEGORIES.includes(d.category)) errors.push('نوع السجل غير صحيح');

  d.full_name = clean(body.full_name, 120);
  if (d.full_name.split(' ').length < 2) errors.push('يرجى كتابة الاسم الثلاثي على الأقل');
  d.name_key = nameKey(d.full_name);
  if (!d.name_key) errors.push('الاسم يجب أن يحتوي على حروف');

  d.status = null;
  if (d.category === 'detainee') {
    d.status = ['released', 'missing'].includes(body.status) ? body.status : null;
    if (!d.status) errors.push('يرجى اختيار حالة المعتقل: مُفرج عنه أو مفقود');
  }

  d.event_date = clean(body.event_date, 10);
  if (!isDate(d.event_date)) errors.push('يرجى إدخال التاريخ');
  else if (d.event_date > today()) errors.push('التاريخ لا يمكن أن يكون في المستقبل');

  d.governorate = clean(body.governorate, 50);
  if (!GOVERNORATES.includes(d.governorate)) errors.push('يرجى اختيار المحافظة');

  d.city = clean(body.city, 80) || null;
  d.area = clean(body.area, 80) || null;

  d.place_of_detention = null;
  if (d.category === 'detainee') {
    d.place_of_detention = clean(body.place_of_detention, 160) || null;
    if (!d.place_of_detention) errors.push('يرجى كتابة مكان الاحتجاز');
  }

  d.notes = clean(body.notes, 500) || null;
  d.contact = clean(body.contact, 120) || null;

  const img = imageValue(body.photo);
  if (!img.ok) errors.push('الصورة غير صالحة أو كبيرة الحجم');
  d.photo = img.value;

  return { errors, d };
}

async function findSimilar(category, key) {
  const { rows } = await pool.query(
    `SELECT id, full_name, governorate, city, to_char(event_date, 'YYYY-MM-DD') AS event_date,
            similarity(name_key, $2) AS score
     FROM records
     WHERE category = $1 AND review_status = 'approved'
       AND name_key % $2 AND similarity(name_key, $2) >= 0.6
     ORDER BY score DESC LIMIT 5`,
    [category, key]
  );
  return rows;
}

// تسجيل حالة: يتطلب حساباً مؤكداً، وتبقى قيد المراجعة
app.post('/api/records', requireUser, submitLimiter, wrap(async (req, res) => {
  const { errors, d } = validateRecord(req.body || {});
  if (errors.length) return fail(res, errors.join('، '));

  const photo = await storeImage(d.photo, 'records');
  const similar = await findSimilar(d.category, d.name_key);
  const { rows } = await pool.query(
    `INSERT INTO records
       (category, status, full_name, name_key, event_date, governorate, city, area,
        place_of_detention, notes, contact, photo, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [d.category, d.status, d.full_name, d.name_key, d.event_date, d.governorate, d.city,
      d.area, d.place_of_detention, d.notes, d.contact, photo, req.user.id]
  );
  res.status(201).json({
    id: rows[0].id,
    message: 'تم استلام التسجيل، وسيُنشر بعد المراجعة',
    similar,
  });
}));

// ---------- الإشراف ----------

app.get('/api/admin/records', requireAdmin, wrap(async (req, res) => {
  const status = STATUS_VALUES.includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await pool.query(
    `SELECT r.id, r.category, r.status, r.full_name,
            to_char(r.event_date, 'YYYY-MM-DD') AS event_date,
            r.governorate, r.city, r.area, r.place_of_detention, r.notes, r.contact,
            r.photo, r.review_status, r.merged_into, u.email AS submitter_email
     FROM records r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.review_status = $1
     ORDER BY r.created_at DESC LIMIT 200`,
    [status]
  );
  res.json({ items: rows });
}));

app.get('/api/admin/duplicates', requireAdmin, wrap(async (req, res) => {
  if (!CATEGORIES.includes(req.query.category)) return fail(res, 'نوع غير صحيح');
  const { rows } = await pool.query(
    `SELECT a.id AS a_id, a.full_name AS a_name, a.governorate AS a_gov, a.city AS a_city,
            b.id AS b_id, b.full_name AS b_name, b.governorate AS b_gov, b.city AS b_city,
            similarity(a.name_key, b.name_key) AS score
     FROM records a
     JOIN records b ON a.category = b.category AND a.id < b.id AND b.name_key % a.name_key
     WHERE a.category = $1
       AND a.review_status = 'approved' AND b.review_status = 'approved'
       AND similarity(a.name_key, b.name_key) >= 0.7
     ORDER BY score DESC LIMIT 100`,
    [req.query.category]
  );
  res.json({ items: rows });
}));

app.post('/api/admin/merge', requireAdmin, wrap(async (req, res) => {
  const from = Number(req.body.from);
  const into = Number(req.body.into);
  if (!from || !into || from === into) return fail(res, 'معرّفات غير صحيحة');
  const target = await pool.query(
    "SELECT id FROM records WHERE id = $1 AND review_status = 'approved'", [into]
  );
  if (!target.rowCount) return fail(res, 'السجل الهدف يجب أن يكون معتمداً');
  const r = await pool.query(
    "UPDATE records SET review_status = 'merged', merged_into = $2 WHERE id = $1", [from, into]
  );
  if (!r.rowCount) return fail(res, 'السجل غير موجود', 404);
  res.json({ ok: true });
}));

app.patch('/api/admin/records/:id', requireAdmin, wrap(async (req, res) => {
  const status = req.body.review_status;
  if (!['pending', 'approved', 'rejected'].includes(status)) return fail(res, 'حالة غير صحيحة');
  const r = await pool.query(
    'UPDATE records SET review_status = $2, merged_into = NULL WHERE id = $1',
    [Number(req.params.id), status]
  );
  if (!r.rowCount) return fail(res, 'غير موجود', 404);
  res.json({ ok: true });
}));

const EDITABLE = {
  full_name: 120, event_date: 10, governorate: 50, city: 80,
  area: 80, place_of_detention: 160, notes: 500, contact: 120,
};
const REQUIRED = ['full_name', 'event_date', 'governorate'];

app.put('/api/admin/records/:id', requireAdmin, wrap(async (req, res) => {
  const sets = [];
  const vals = [];
  for (const [field, max] of Object.entries(EDITABLE)) {
    if (!(field in req.body)) continue;
    const value = clean(req.body[field], max) || null;
    if (REQUIRED.includes(field) && !value) return fail(res, `الحقل ${field} مطلوب`);
    if (field === 'event_date' && value && !isDate(value)) return fail(res, 'صيغة التاريخ غير صحيحة');
    if (field === 'governorate' && !GOVERNORATES.includes(value)) return fail(res, 'محافظة غير صحيحة');
    vals.push(value);
    sets.push(`${field} = $${vals.length}`);
    if (field === 'full_name') {
      vals.push(nameKey(value));
      sets.push(`name_key = $${vals.length}`);
    }
  }
  if ('status' in req.body) {
    const s = req.body.status;
    if (s !== null && !['released', 'missing'].includes(s)) return fail(res, 'حالة غير صحيحة');
    vals.push(s);
    sets.push(`status = $${vals.length}`);
  }
  if (!sets.length) return fail(res, 'لا توجد بيانات للتعديل');

  vals.push(Number(req.params.id));
  const r = await pool.query(
    `UPDATE records SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals
  );
  if (!r.rowCount) return fail(res, 'غير موجود', 404);
  res.json({ ok: true });
}));

app.delete('/api/admin/records/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  await pool.query(
    "UPDATE records SET review_status = 'pending', merged_into = NULL WHERE merged_into = $1", [id]
  );
  const r = await pool.query('DELETE FROM records WHERE id = $1 RETURNING photo', [id]);
  if (!r.rowCount) return fail(res, 'غير موجود', 404);
  await removeImage(r.rows[0].photo);
  res.json({ ok: true });
}));

app.get('/api/admin/export.csv', requireAdmin, wrap(async (req, res) => {
  const lang = req.query.lang === 'en' ? 'en' : 'ar';
  await streamExport(res, 'records-admin.csv', lang, buildFilter(req.query, { admin: true }), ADMIN_COLUMNS);
}));

app.get('/api/admin/users', requireAdmin, wrap(async (req, res) => {
  const q = clean(req.query.q, 100).replace(/[%_\\]/g, '');
  const { rows } = await pool.query(
    `SELECT id, email, display_name, role, blocked, email_verified,
            to_char(created_at, 'YYYY-MM-DD') AS created_at
     FROM users
     WHERE ($1 = '' OR email ILIKE $2 OR display_name ILIKE $2)
     ORDER BY id DESC LIMIT 200`,
    [q, `%${q}%`]
  );
  res.json({ items: rows });
}));

app.patch('/api/admin/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const isSelf = id === req.user.id;
  if (isSelf && (b.blocked === true || b.role === 'user')) {
    return fail(res, 'لا يمكنك إيقاف أو إزالة صلاحيات حسابك');
  }
  const sets = [];
  const vals = [];
  if (typeof b.blocked === 'boolean') {
    vals.push(b.blocked);
    sets.push(`blocked = $${vals.length}`);
  }
  if (['user', 'admin'].includes(b.role)) {
    vals.push(b.role);
    sets.push(`role = $${vals.length}`);
  }
  if (!sets.length) return fail(res, 'لا توجد تغييرات');
  vals.push(id);
  const r = await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals);
  if (!r.rowCount) return fail(res, 'المستخدم غير موجود', 404);
  if (b.blocked === true) await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  res.json({ ok: true });
}));

app.put('/api/admin/settings', requireAdmin, wrap(async (req, res) => {
  const banner = String(req.body.banner ?? '').slice(0, 2000).trim();
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ('banner', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [banner]
  );
  res.json({ ok: true });
}));

// ---------- التشغيل ----------

try {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('تم تجهيز قاعدة البيانات');
  console.log(storageEnabled
    ? 'التخزين: Cloudflare R2'
    : 'التخزين: داخل قاعدة البيانات (وضع التطوير، غير مسموح في الإنتاج)');
} catch (err) {
  console.error('فشل تجهيز قاعدة البيانات:', err.message);
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`المنصة تعمل على http://localhost:${PORT}`));
