const PANELS = ['login', 'register', 'verify', 'forgot', 'reset'];
let pendingEmail = '';

function showPanel(name) {
  for (const p of PANELS) $(p + 'Panel').hidden = p !== name;
  history.replaceState(null, '', name === 'login' ? '/auth.html' : '/auth.html#' + name);
  $('authMsg').hidden = true;
}

function showMsg(text, ok) {
  const box = $('authMsg');
  box.textContent = text;
  box.className = 'msg ' + (ok ? 'ok' : 'error');
  box.hidden = false;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// إرسال نموذج مع معالجة الأخطاء وإظهار الرسالة
function onSubmit(formId, handler) {
  $(formId).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await handler(formData(e.target), e.target);
    } catch (err) {
      if (err.data && err.data.needs_verification) {
        pendingEmail = formData(e.target).email;
        $('verifyNote').textContent = t('auth.verify_sent', pendingEmail);
        showPanel('verify');
      }
      showMsg(err.message, false);
    } finally {
      btn.disabled = false;
    }
  });
}

function bindAuth() {
  document.querySelectorAll('[data-go]').forEach((btn) => {
    btn.addEventListener('click', () => showPanel(btn.dataset.go));
  });

  onSubmit('loginForm', async (data) => {
    await api('/api/auth/login', { method: 'POST', body: data });
    location.href = '/';
  });

  onSubmit('registerForm', async (data) => {
    const res = await api('/api/auth/register', { method: 'POST', body: data });
    pendingEmail = data.email;
    $('verifyNote').textContent = t('auth.verify_sent', pendingEmail);
    showPanel('verify');
    showMsg(res.message, true);
  });

  onSubmit('verifyForm', async (data, form) => {
    await api('/api/auth/verify', { method: 'POST', body: { email: pendingEmail, code: data.code } });
    form.reset();
    showMsg(t('auth.done'), true);
    setTimeout(() => { location.href = '/'; }, 800);
  });

  $('resendBtn').addEventListener('click', async () => {
    try {
      await api('/api/auth/resend', { method: 'POST', body: { email: pendingEmail } });
      showMsg(t('auth.verify_sent', pendingEmail), true);
    } catch (err) {
      showMsg(err.message, false);
    }
  });

  onSubmit('forgotForm', async (data) => {
    await api('/api/auth/forgot', { method: 'POST', body: data });
    pendingEmail = data.email;
    showPanel('reset');
    showMsg(t('auth.reset_sent'), true);
  });

  onSubmit('resetForm', async (data, form) => {
    await api('/api/auth/reset', { method: 'POST', body: { email: pendingEmail, ...data } });
    form.reset();
    showPanel('login');
    showMsg(t('auth.reset_done'), true);
  });
}

window.onLangChange = () => {
  if (pendingEmail) $('verifyNote').textContent = t('auth.verify_sent', pendingEmail);
};

window.pageInit = () => {
  if (CURRENT.user) {
    location.href = '/';
    return;
  }
  bindAuth();
  const start = location.hash.replace('#', '');
  showPanel(PANELS.includes(start) ? start : 'login');
};
