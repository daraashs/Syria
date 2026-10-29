const state = {
  cat: 'martyr',
  page: 1,
  pages: 1,
  governorates: [],
  photo: null,
};

function formatDate(iso) {
  return iso ? iso.split('-').reverse().join('/') : '';
}

function fillGovernorates(select) {
  for (const g of state.governorates) {
    const o = document.createElement('option');
    o.value = g;
    o.textContent = g;
    select.appendChild(o);
  }
}

function renderBanner(text) {
  const box = $('siteBanner');
  box.textContent = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const p = document.createElement('p');
    p.textContent = line.trim();
    box.appendChild(p);
  }
}

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    renderBanner(data.banner);
  } catch {
    renderBanner('');
  }
}

async function loadStats() {
  const s = await api('/api/stats');
  $('cnt-martyr').textContent = s.martyr.total;
  $('cnt-missing').textContent = s.missing.total;
  $('cnt-detainee').textContent = s.detainee.total;
  $('cnt-released').textContent = s.detainee.released;
  $('cnt-detained-missing').textContent = s.detainee.missing;
}

function currentParams() {
  const params = new URLSearchParams();
  params.set('category', state.cat);
  for (const [key, value] of new FormData($('searchForm')).entries()) {
    if (!value) continue;
    if (key === 'status' && state.cat !== 'detainee') continue;
    params.set(key, value);
  }
  return params;
}

function renderCard(r) {
  const card = document.createElement('article');
  card.className = 'rec';

  if (r.photo) {
    const img = document.createElement('img');
    img.src = r.photo;
    img.alt = '';
    img.loading = 'lazy';
    card.appendChild(img);
  }

  const title = document.createElement('h3');
  title.textContent = r.full_name;
  card.appendChild(title);

  const lines = [
    [t(`date.${r.category}`), formatDate(r.event_date)],
    [t('field.governorate'), r.governorate],
    [t('field.city'), r.city],
    [t('field.area'), r.area],
  ];
  if (r.category === 'detainee') {
    lines.push([t('field.status'), t(`status.${r.status}`)]);
    lines.push([t('field.detention'), r.place_of_detention]);
  }
  if (r.notes) lines.push([t('field.notes'), r.notes]);

  for (const [label, value] of lines) {
    if (!value) continue;
    const p = document.createElement('p');
    const b = document.createElement('b');
    b.textContent = label + ': ';
    const span = document.createElement('span');
    span.textContent = value;
    p.append(b, span);
    card.appendChild(p);
  }
  return card;
}

async function loadRecords() {
  const params = currentParams();
  params.set('page', state.page);
  const results = $('results');
  results.textContent = '';

  let data;
  try {
    data = await api('/api/records?' + params.toString());
  } catch (err) {
    $('resultCount').textContent = err.message || t('msg.load_error');
    return;
  }

  state.pages = data.pages;
  $('resultCount').textContent = t('search.count', data.total);
  $('pageInfo').textContent = t('search.page', data.page, data.pages);
  $('prev').disabled = data.page <= 1;
  $('next').disabled = data.page >= data.pages;

  if (!data.items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = t('search.none');
    results.appendChild(empty);
    return;
  }
  for (const item of data.items) results.appendChild(renderCard(item));
}

function setCategory(cat) {
  state.cat = cat;
  state.page = 1;
  document.querySelectorAll('.tab[data-cat]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.cat === cat);
  });
  $('statusFilter').hidden = cat !== 'detainee';
  loadRecords();
}

function syncRegisterForm() {
  const cat = $('regCategory').value;
  const isDetainee = cat === 'detainee';
  $('statusBox').hidden = !isDetainee;
  $('detentionBox').hidden = !isDetainee;
  $('dateText').textContent = t(`date.${cat}`);
}

function showMessage(text, ok) {
  const box = $('formMsg');
  box.textContent = text;
  box.className = 'msg ' + (ok ? 'ok' : 'error');
  box.hidden = false;
}

function clearPhoto() {
  state.photo = null;
  $('photoInput').value = '';
  $('photoPreview').hidden = true;
  $('photoPreview').removeAttribute('src');
  $('removePhoto').hidden = true;
}

async function onPhotoChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state.photo = await resizeImage(file, 160, 120000);
    $('photoPreview').src = state.photo;
    $('photoPreview').hidden = false;
    $('removePhoto').hidden = false;
  } catch (err) {
    showMessage(err.message, false);
    clearPhoto();
  }
}

async function onRegisterSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  body.photo = state.photo || '';

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const data = await api('/api/records', { method: 'POST', body });
    let text = t('msg.sent');
    if (data.similar && data.similar.length) {
      const names = data.similar.map((s) => `${s.full_name} (${s.governorate})`).join('، ');
      text += '. ' + t('msg.similar', names);
    }
    showMessage(text, true);
    form.reset();
    clearPhoto();
    syncRegisterForm();
  } catch (err) {
    showMessage(err.message, false);
  } finally {
    submitBtn.disabled = false;
  }
}

function exportCsv() {
  const params = currentParams();
  params.set('lang', getLang());
  location.href = '/api/records/export.csv?' + params.toString();
}

function bindEvents() {
  document.querySelectorAll('.tab[data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => setCategory(btn.dataset.cat));
  });

  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.page = 1;
    loadRecords();
  });

  $('resetBtn').addEventListener('click', () => {
    $('searchForm').reset();
    state.page = 1;
    loadRecords();
  });

  $('exportBtn').addEventListener('click', exportCsv);

  $('prev').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      loadRecords();
    }
  });

  $('next').addEventListener('click', () => {
    if (state.page < state.pages) {
      state.page += 1;
      loadRecords();
    }
  });

  $('openRegister').addEventListener('click', () => {
    $('registerSection').hidden = false;
    $('registerSection').scrollIntoView({ behavior: 'smooth' });
  });

  $('closeRegister').addEventListener('click', () => {
    $('registerSection').hidden = true;
  });

  $('regCategory').addEventListener('change', syncRegisterForm);
  $('photoInput').addEventListener('change', onPhotoChange);
  $('removePhoto').addEventListener('click', clearPhoto);
  $('registerForm').addEventListener('submit', onRegisterSubmit);
  $('regDate').max = new Date().toISOString().slice(0, 10);
}

window.onLangChange = () => {
  syncRegisterForm();
  loadRecords();
};

window.pageInit = async () => {
  bindEvents();
  syncRegisterForm();
  try {
    const meta = await api('/api/meta');
    state.governorates = meta.governorates;
    fillGovernorates($('govFilter'));
    fillGovernorates($('regGov'));
  } catch {
    showMessage(t('msg.network'), false);
  }
  await Promise.all([loadSettings(), loadStats(), loadRecords()]);
};
