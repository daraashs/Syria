// القيم التي تُرسل: undefined تعني "لم تتغير"، والنص الفارغ يعني "إزالة"
const pending = { avatar: undefined, logo: undefined };

function showMsg(id, text, ok) {
  const box = $(id);
  box.textContent = text;
  box.className = 'msg ' + (ok ? 'ok' : 'error');
  box.hidden = false;
}

function fillForm(user) {
  const form = $('profileForm');
  $('email').value = user.email;
  form.display_name.value = user.display_name || '';
  form.bio.value = user.bio || '';
  form.lang.value = user.lang || 'ar';
  showPreview('avatar', user.avatar);
  showPreview('logo', user.logo);
}

function showPreview(field, src) {
  const img = $(field + 'Preview');
  if (src) {
    img.src = src;
    img.hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }
}

async function onFile(e) {
  const field = e.target.dataset.field;
  const file = e.target.files[0];
  if (!file) return;
  try {
    // الصورة الشخصية والشعار تُصغَّران إلى 256 بكسل
    const data = await resizeImage(file, 256, 150000);
    pending[field] = data;
    showPreview(field, data);
  } catch (err) {
    showMsg('profileMsg', err.message, false);
  }
}

function removeImage(field) {
  pending[field] = '';
  $(field + 'Preview').hidden = true;
  $(field + 'Preview').removeAttribute('src');
}

async function saveProfile(e) {
  e.preventDefault();
  const form = e.target;
  const body = {
    display_name: form.display_name.value,
    bio: form.bio.value,
    lang: form.lang.value,
  };
  if (pending.avatar !== undefined) body.avatar = pending.avatar;
  if (pending.logo !== undefined) body.logo = pending.logo;

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await api('/api/me', { method: 'PUT', body });
    CURRENT.user = res.user;
    pending.avatar = undefined;
    pending.logo = undefined;
    $('navName').textContent = res.user.display_name;
    setLang(res.user.lang);
    showMsg('profileMsg', t('prof.saved'), true);
  } catch (err) {
    showMsg('profileMsg', err.message, false);
  } finally {
    btn.disabled = false;
  }
}

async function changePassword(e) {
  e.preventDefault();
  const form = e.target;
  try {
    await api('/api/me/password', {
      method: 'POST',
      body: { current: form.current.value, password: form.password.value },
    });
    form.reset();
    showMsg('pwMsg', t('prof.pw_done'), true);
  } catch (err) {
    showMsg('pwMsg', err.message, false);
  }
}

window.onLangChange = () => {};

window.pageInit = () => {
  if (!CURRENT.user) {
    location.href = '/auth.html';
    return;
  }
  fillForm(CURRENT.user);
  $('profileForm').addEventListener('submit', saveProfile);
  $('passwordForm').addEventListener('submit', changePassword);
  document.querySelectorAll('input[type="file"][data-field]').forEach((input) => {
    input.addEventListener('change', onFile);
  });
  document.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeImage(btn.dataset.remove));
  });
};
