const CAT = { martyr: 'cat.martyr', missing: 'cat.missing', detainee: 'cat.detainee' };
const TAB_LOADERS = {};
let currentTab = 'pending';

function showTab(name) {
  currentTab = name;
  document.querySelectorAll('#tabs .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  const isRecords = ['pending', 'approved', 'rejected', 'merged'].includes(name);
  $('recordsPanel').hidden = !isRecords;
  $('dupsPanel').hidden = name !== 'dups';
  $('usersPanel').hidden = name !== 'users';
  $('settingsPanel').hidden = name !== 'settings';
  $('exportPanel').hidden = name !== 'export';
  if (isRecords) loadRecords(name);
  if (TAB_LOADERS[name]) TAB_LOADERS[name]();
}

function actionButton(text, onClick, className) {
  const btn = document.createElement('button');
  btn.textContent = text;
  if (className) btn.className = className;
  btn.addEventListener('click', onClick);
  return btn;
}

function onError(err) {
  alert(err.message);
}

async function setReview(id, review_status) {
  try {
    await api(`/api/admin/records/${id}`, { method: 'PATCH', body: { review_status } });
    loadRecords(currentTab);
  } catch (err) {
    onError(err);
  }
}

async function editName(record) {
  const name = prompt(t('adm.edit_prompt'), record.full_name);
  if (!name || name === record.full_name) return;
  try {
    await api(`/api/admin/records/${record.id}`, { method: 'PUT', body: { full_name: name } });
    loadRecords(currentTab);
  } catch (err) {
    onError(err);
  }
}

async function deleteRecord(id) {
  if (!confirm(t('adm.confirm_delete'))) return;
  try {
    await api(`/api/admin/records/${id}`, { method: 'DELETE' });
    loadRecords(currentTab);
  } catch (err) {
    onError(err);
  }
}

function buildRecordRow(r) {
  const box = document.createElement('article');
  box.className = 'admin-row';

  const info = document.createElement('div');
  const title = document.createElement('strong');
  let label = `#${r.id} — ${r.full_name} (${t(CAT[r.category])}`;
  if (r.status) label += ` / ${t('status.' + r.status)}`;
  title.textContent = label + ')';
  info.appendChild(title);

  const details = [
    r.event_date, r.governorate, r.city, r.area, r.place_of_detention,
    r.contact ? `☎ ${r.contact}` : '',
    r.notes,
  ].filter(Boolean).join(' | ');
  const p = document.createElement('p');
  p.textContent = details;
  info.appendChild(p);

  if (r.submitter_email) {
    const s = document.createElement('p');
    s.textContent = `${t('adm.submitter')}: ${r.submitter_email}`;
    info.appendChild(s);
  }
  if (r.merged_into) {
    const m = document.createElement('p');
    m.textContent = `#${r.merged_into}`;
    info.appendChild(m);
  }
  box.appendChild(info);

  if (r.photo) {
    const img = document.createElement('img');
    img.src = r.photo;
    img.alt = '';
    box.appendChild(img);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (r.review_status !== 'approved') {
    actions.appendChild(actionButton(t('adm.approve'), () => setReview(r.id, 'approved')));
  }
  if (r.review_status !== 'rejected') {
    actions.appendChild(actionButton(t('adm.reject'), () => setReview(r.id, 'rejected'), 'ghost'));
  }
  if (r.review_status !== 'pending') {
    actions.appendChild(actionButton(t('adm.reopen'), () => setReview(r.id, 'pending'), 'ghost'));
  }
  actions.appendChild(actionButton(t('adm.edit'), () => editName(r), 'ghost'));
  actions.appendChild(actionButton(t('adm.delete'), () => deleteRecord(r.id), 'danger'));
  box.appendChild(actions);
  return box;
}

async function loadRecords(status) {
  const list = $('list');
  list.textContent = '';
  try {
    const data = await api(`/api/admin/records?status=${status}`);
    if (!data.items.length) {
      list.textContent = t('adm.none');
      return;
    }
    for (const r of data.items) list.appendChild(buildRecordRow(r));
  } catch (err) {
    onError(err);
  }
}

async function mergeInto(fromId, intoId) {
  if (!confirm(t('adm.confirm_merge', fromId, intoId))) return;
  try {
    await api('/api/admin/merge', { method: 'POST', body: { from: fromId, into: intoId } });
    loadDuplicates();
  } catch (err) {
    onError(err);
  }
}

async function loadDuplicates() {
  const box = $('dups');
  box.textContent = '';
  try {
    const data = await api(`/api/admin/duplicates?category=${$('dupCat').value}`);
    if (!data.items.length) {
      box.textContent = t('adm.none');
      return;
    }
    for (const d of data.items) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const text = document.createElement('span');
      text.textContent =
        `#${d.a_id} ${d.a_name} (${d.a_gov}${d.a_city ? ' - ' + d.a_city : ''})  ↔  ` +
        `#${d.b_id} ${d.b_name} (${d.b_gov}${d.b_city ? ' - ' + d.b_city : ''})  — ` +
        `${t('adm.dup_score')} ${Math.round(d.score * 100)}%`;
      row.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.appendChild(actionButton(t('adm.merge_in', d.b_id, d.a_id), () => mergeInto(d.b_id, d.a_id), 'ghost'));
      actions.appendChild(actionButton(t('adm.merge_in', d.a_id, d.b_id), () => mergeInto(d.a_id, d.b_id), 'ghost'));
      row.appendChild(actions);
      box.appendChild(row);
    }
  } catch (err) {
    onError(err);
  }
}

async function loadUsers() {
  const box = $('users');
  box.textContent = '';
  try {
    const q = encodeURIComponent($('userQuery').value.trim());
    const data = await api(`/api/admin/users?q=${q}`);
    if (!data.items.length) {
      box.textContent = t('adm.none');
      return;
    }
    for (const u of data.items) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${u.display_name} — ${u.email}`;
      const meta = document.createElement('p');
      meta.textContent = [
        u.role === 'admin' ? 'admin' : 'user',
        u.email_verified ? '' : 'unverified',
        u.blocked ? 'blocked' : '',
        u.created_at,
      ].filter(Boolean).join(' | ');
      info.append(title, meta);
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const patch = (body) => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body })
        .then(loadUsers)
        .catch(onError);
      actions.appendChild(u.blocked
        ? actionButton(t('adm.unblock'), () => patch({ blocked: false }), 'ghost')
        : actionButton(t('adm.block'), () => patch({ blocked: true }), 'danger'));
      actions.appendChild(u.role === 'admin'
        ? actionButton(t('adm.remove_admin'), () => patch({ role: 'user' }), 'ghost')
        : actionButton(t('adm.make_admin'), () => patch({ role: 'admin' }), 'ghost'));
      row.appendChild(actions);
      box.appendChild(row);
    }
  } catch (err) {
    onError(err);
  }
}

async function loadBanner() {
  const data = await api('/api/settings');
  $('bannerText').value = data.banner;
}

function exportWithParams(form) {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form).entries()) {
    if (value) params.set(key, value);
  }
  location.href = '/api/admin/export.csv?' + params.toString();
}

function bindAdmin() {
  document.querySelectorAll('#tabs .tab').forEach((b) => {
    b.addEventListener('click', () => showTab(b.dataset.tab));
  });
  $('dupBtn').addEventListener('click', loadDuplicates);
  $('userBtn').addEventListener('click', loadUsers);
  $('userQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadUsers();
  });

  $('bannerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { banner: $('bannerText').value } });
      $('bannerMsg').textContent = t('adm.saved');
      $('bannerMsg').className = 'msg ok';
      $('bannerMsg').hidden = false;
    } catch (err) {
      onError(err);
    }
  });

  $('exportForm').addEventListener('submit', (e) => {
    e.preventDefault();
    exportWithParams(e.target);
  });

  TAB_LOADERS.settings = () => loadBanner().catch(onError);
}

window.onLangChange = () => {
  if ($('adminPanel') && !$('adminPanel').hidden) showTab(currentTab);
};

window.pageInit = () => {
  if (!CURRENT.user) {
    $('denied').hidden = false;
    $('denied').querySelector('p').textContent = t('adm.need_admin');
    return;
  }
  if (CURRENT.user.role !== 'admin') {
    $('denied').hidden = false;
    return;
  }
  bindAdmin();
  $('adminPanel').hidden = false;
  showTab('pending');
};
