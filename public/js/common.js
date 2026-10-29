const $ = (id) => document.getElementById(id);

const CURRENT = { user: null };

// استدعاء الـ API: يرمي خطأ يحمل رسالة الخادم
async function api(url, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error(t('msg.network'));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || t('msg.generic'));
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function getLang() {
  return localStorage.getItem('lang') || 'ar';
}

// يطبق الترجمة على كل عنصر يحمل data-i18n
function applyLang(lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  const sel = $('langSelect');
  if (sel) sel.value = lang;
}

function setLang(lang) {
  localStorage.setItem('lang', lang);
  applyLang(lang);
  if (typeof window.onLangChange === 'function') window.onLangChange();
}

// إظهار عناصر حسب الدور: guest (زائر) / user (مسجّل) / admin (مشرف)
function renderAuth() {
  const u = CURRENT.user;
  document.querySelectorAll('[data-show]').forEach((el) => {
    const need = el.dataset.show;
    let show = true;
    if (need === 'guest') show = !u;
    if (need === 'user') show = !!u;
    if (need === 'admin') show = !!(u && u.role === 'admin');
    el.hidden = !show;
  });
  if ($('navName') && u) $('navName').textContent = u.display_name;
  if ($('logoutBtn')) {
    $('logoutBtn').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      location.href = '/';
    });
  }
}

// تصغير الصورة وضغطها قبل الرفع (القيم الافتراضية مناسبة للصور المصغرة)
function resizeImage(file, maxSide = 160, maxLen = 120000) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) {
      return reject(new Error(t('msg.bad_image')));
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      let quality = 0.85;
      let out = canvas.toDataURL('image/jpeg', quality);
      while (out.length > maxLen && quality > 0.3) {
        quality -= 0.1;
        out = canvas.toDataURL('image/jpeg', quality);
      }
      URL.revokeObjectURL(url);
      resolve(out);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t('msg.bad_image')));
    };
    img.src = url;
  });
}

// تهيئة مشتركة لكل الصفحات
document.addEventListener('DOMContentLoaded', async () => {
  const lang = getLang();
  applyLang(lang);
  const sel = $('langSelect');
  if (sel) {
    sel.addEventListener('change', async (e) => {
      setLang(e.target.value);
      if (CURRENT.user) {
        api('/api/me', { method: 'PUT', body: { lang: e.target.value } }).catch(() => {});
      }
    });
  }

  try {
    CURRENT.user = (await api('/api/me')).user;
  } catch {
    CURRENT.user = null;
  }
  // لغة الحساب المحفوظة تُطبَّق عند الدخول
  if (CURRENT.user && CURRENT.user.lang !== lang) setLang(CURRENT.user.lang);

  renderAuth();
  if (typeof window.pageInit === 'function') window.pageInit();
});
