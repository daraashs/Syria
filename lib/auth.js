import crypto from 'crypto';

// تجزئة كلمة المرور بخوارزمية scrypt مع ملح عشوائي
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// رمز تحقق من ستة أرقام
export const randomCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// رمز جلسة عشوائي طويل
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
