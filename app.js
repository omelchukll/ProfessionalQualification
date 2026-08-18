const PATHS = {
  index: './data/index.json',
  levels: './data/references/education-levels.json',
  units: './data/references/units.json',
  specialties: './data/references/specialties.json',
  program: id => `./data/programs/${id}.json`,
  programQualifications: id => `./data/program-qualifications/${id}.json`
};

const state = {
  index: [],
  filtered: [],
  levels: new Map(),
  units: new Map(),
  specialties: new Map(),
  currentPage: 1,
  pageSize: 20,
  sortKey: 'nameUk',
  sortDirection: 'asc',
  selectedId: null,
  view: 'programs'
};

const $ = id => document.getElementById(id);

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function unwrapArray(doc, key) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc[key])) return doc[key];
  return [];
}

async function init() {
  try {
    const [indexDoc, levelsDoc, unitsDoc, specialtiesDoc] = await Promise.all([
      getJson(PATHS.index), getJson(PATHS.levels), getJson(PATHS.units), getJson(PATHS.specialties)
    ]);

    state.index = unwrapArray(indexDoc, 'programs');
    unwrapArray(levelsDoc, 'educationLevels').forEach(x => state.levels.set(x.id, x));
    unwrapArray(unitsDoc, 'units').forEach(x => state.units.set(x.id, x));
    unwrapArray(specialtiesDoc, 'specialties').forEach(x => state.specialties.set(x.id, x));

    // Support files whose root itself is the array (our current reference JSONs).
    if (!state.levels.size && Array.isArray(levelsDoc)) levelsDoc.forEach(x => state.levels.set(x.id, x));
    if (!state.units.size && Array.isArray(unitsDoc)) unitsDoc.forEach(x => state.units.set(x.id, x));

    fillReferenceFilters();
    bindEvents();
    updateStats(indexDoc);
    applyFilters();
    $('dataStatus').textContent = `Дані завантажено: ${state.index.length} ОП`;
  } catch (err) {
    console.error(err);
    $('dataStatus').textContent = 'Помилка завантаження';
    document.querySelector('.content').innerHTML = `
      <div class="error-box">
        <strong>Не вдалося завантажити JSON.</strong><br><br>
        ${escapeHtml(err.message)}<br><br>
        Відкривайте сайт через HTTP server або GitHub Pages, а не подвійним кліком по index.html.
      </div>`;
  }
}

function fillReferenceFilters() {
  const levelSelect = $('filterLevel');
  [...state.levels.values()]
    .sort((a,b) => (a.order ?? 999) - (b.order ?? 999))
    .forEach(x => levelSelect.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(x.id)}">${escapeHtml(x.nameUk || x.name || x.id)}</option>`));

  const unitSelect = $('filterUnit');
  [...state.units.values()]
    .filter(x => x.active !== false)
    .sort((a,b) => (a.order ?? 999) - (b.order ?? 999))
    .forEach(x => unitSelect.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(x.id)}">${escapeHtml(x.shortNameUk || x.nameUk || x.id)}</option>`));
}

function bindEvents() {
  ['globalSearch','filterListYear','filterLevel','filterUnit','filterQualificationStatus','filterHasQualifications']
    .forEach(id => $(id).addEventListener(id === 'globalSearch' ? 'input' : 'change', () => {
      state.currentPage = 1;
      applyFilters();
    }));

  $('pageSize').addEventListener('change', e => {
    state.pageSize = Number(e.target.value);
    state.currentPage = 1;
    renderTable();
  });

  $('resetFilters').addEventListener('click', () => {
    $('globalSearch').value = '';
    ['filterListYear','filterLevel','filterUnit','filterQualificationStatus','filterHasQualifications'].forEach(id => $(id).value = '');
    state.currentPage = 1;
    applyFilters();
  });

  $('prevPage').addEventListener('click', () => {
    if (state.currentPage > 1) { state.currentPage--; renderTable(); }
  });
  $('nextPage').addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.currentPage < pages) { state.currentPage++; renderTable(); }
  });

  document.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = key; state.sortDirection = 'asc'; }
    renderTable();
  }));

  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    state.view = btn.dataset.view;
    state.currentPage = 1;
    applyFilters();
  }));
}

function updateStats(indexDoc) {
  $('statAll').textContent = indexDoc.programCount ?? state.index.length;
  $('statWith').textContent = indexDoc.programsWithQualifications ?? state.index.filter(x => x.hasQualifications).length;
  $('statExtended').textContent = indexDoc.programsWithExtendedQualifications ?? state.index.filter(x => x.hasExtendedQualifications).length;
  $('statWithout').textContent = indexDoc.programsWithoutQualifications ?? state.index.filter(x => !x.hasQualifications).length;
}

function applyFilters() {
  const q = $('globalSearch').value.trim().toLocaleLowerCase('uk-UA');
  const year = $('filterListYear').value;
  const level = $('filterLevel').value;
  const unit = $('filterUnit').value;
  const qStatus = $('filterQualificationStatus').value;
  const hasQ = $('filterHasQualifications').value;

  state.filtered = state.index.filter(p => {
    if (state.view === 'qualifications' && !p.hasQualifications) return false;
    if (state.view === 'attention') {
      const needsAttention = !p.hasQualifications || (p.listYear === 2015 && !p.hasExtendedQualifications);
      if (!needsAttention) return false;
    }
    if (q && !(p.searchText || '').includes(q)) return false;
    if (year && String(p.listYear) !== year) return false;
    if (level && p.educationLevelId !== level) return false;
    if (unit && p.unitId !== unit) return false;
    if (qStatus && p.qualificationStatus !== qStatus) return false;
    if (hasQ === 'yes' && !p.hasQualifications) return false;
    if (hasQ === 'no' && p.hasQualifications) return false;
    return true;
  });

  $('visibleCount').textContent = `${state.filtered.length} ОП`;
  $('tableTitle').textContent = state.view === 'attention' ? 'Потребують уваги' : state.view === 'qualifications' ? 'ОП з професійними кваліфікаціями' : 'Освітні програми';
  $('tableSubtitle').textContent = state.view === 'attention' ? 'Попередній контроль: без ПК або старий перелік без поширення' : 'Пошук і фільтрація реєстру';
  renderTable();
}

function sortedRows(rows) {
  const dir = state.sortDirection === 'asc' ? 1 : -1;
  return [...rows].sort((a,b) => {
    const av = a[state.sortKey] ?? '';
    const bv = b[state.sortKey] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av-bv) * dir;
    return String(av).localeCompare(String(bv), 'uk', { numeric: true, sensitivity: 'base' }) * dir;
  });
}

function renderTable() {
  const rows = sortedRows(state.filtered);
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  if (state.currentPage > pages) state.currentPage = pages;
  const start = (state.currentPage - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  $('programRows').innerHTML = pageRows.map(p => `
    <tr data-id="${escapeAttr(p.edeboId)}" class="${String(state.selectedId) === String(p.edeboId) ? 'selected' : ''}">
      <td><span class="cell-title">${escapeHtml(p.edeboId)}</span></td>
      <td>
        <div class="cell-title">${escapeHtml(p.nameUk || '—')}</div>
        <div class="cell-sub">${escapeHtml(programTypeLabel(p.programType))}</div>
      </td>
      <td>
        <div class="cell-title">${escapeHtml(p.specialtyCodeRaw || '—')}</div>
        <div class="cell-sub">${escapeHtml(p.specialtyNameUk || '')}</div>
      </td>
      <td>${escapeHtml(levelLabel(p.educationLevelId))}</td>
      <td>${escapeHtml(unitLabel(p.unitId, p.unitNameUk))}</td>
      <td><span class="badge ${p.qualificationCount ? 'green' : 'subtle'}">${p.qualificationCount ?? 0}</span></td>
      <td>${statusBadge(p)}</td>
    </tr>`).join('') || `<tr><td colspan="7" class="muted">Нічого не знайдено.</td></tr>`;

  document.querySelectorAll('#programRows tr[data-id]').forEach(tr => tr.addEventListener('click', () => openDetails(tr.dataset.id)));

  $('pageInfo').textContent = `${state.currentPage} / ${pages}`;
  $('prevPage').disabled = state.currentPage <= 1;
  $('nextPage').disabled = state.currentPage >= pages;
}

async function openDetails(edeboId) {
  state.selectedId = edeboId;
  renderTable();
  const panel = $('detailsPanel');
  panel.classList.remove('empty');
  panel.innerHTML = `<div class="muted">Завантаження картки…</div>`;

  try {
    const indexEntry = state.index.find(x => String(x.edeboId) === String(edeboId));
    const [program, pq] = await Promise.all([
      getJson(PATHS.program(edeboId)),
      getJson(PATHS.programQualifications(edeboId)).catch(() => ({ qualifications: [] }))
    ]);

    const tpl = $('detailsTemplate').content.cloneNode(true);
    panel.innerHTML = '';
    panel.appendChild(tpl);

    $('detailName').textContent = program.nameUk || indexEntry?.nameUk || 'Без назви';
    $('detailId').textContent = `ID ОП: ${program.edeboId ?? edeboId}`;

    const specialties = (program.specialtyIds || []).map(id => state.specialties.get(id)).filter(Boolean);
    const specialtyText = specialties.length
      ? specialties.map(x => `${x.code} ${x.nameUk}`).join('; ')
      : [program.specialtyCodeRaw, program.specialtyNameRaw].filter(Boolean).join(' ');

    $('detailMeta').innerHTML = [
      ['Перелік', program.classifierId === 'specialties-2024' ? '2024' : program.classifierId === 'specialties-2015' ? '2015' : '—'],
      ['Спеціальність', specialtyText || '—'],
      ['Рівень', levelLabel(program.educationLevelId)],
      ['Підрозділ', unitLabel(program.unitId, program.unitNameRaw)],
      ['Форма', program.studyForm || '—']
    ].map(([label,val]) => `<div class="meta-row"><div class="meta-label">${escapeHtml(label)}</div><div>${escapeHtml(val)}</div></div>`).join('');

    const rels = pq.qualifications || [];
    $('detailQualificationCount').textContent = `${rels.length} ПК`;
    $('detailQualifications').innerHTML = rels.length ? rels.map(r => {
      const q = indexEntry?.qualifications?.find(x => x.id === r.qualificationId);
      const type = r.relationType === 'extended' ? '<span class="badge purple">Поширено</span>' : '<span class="badge green">Погоджено</span>';
      const order = r.relationType === 'extended' ? r.extension?.order : r.approval?.order;
      return `<div class="qualification-item">
        <div class="qualification-title">${escapeHtml(q?.nameUk || r.sourceQualificationText || r.qualificationId)}</div>
        ${q?.nameEn ? `<div class="qualification-en">${escapeHtml(q.nameEn)}</div>` : ''}
        <div class="qualification-meta">${type}${order?.raw ? `<span class="badge subtle">${escapeHtml(order.raw)}</span>` : ''}</div>
      </div>`;
    }).join('') : '<div class="muted">Професійні кваліфікації не зафіксовані.</div>';

    const ext = rels.filter(r => r.relationType === 'extended');
    if (!ext.length) $('extensionSection').style.display = 'none';
    else $('detailExtensions').innerHTML = ext.map(r => `<div class="extension-item">
      <div><strong>Джерело:</strong> ${escapeHtml(r.sourceProgramId || '—')}</div>
      <div class="muted" style="margin-top:6px">${escapeHtml(r.extension?.order?.raw || 'Наказ не зазначено')}</div>
    </div>`).join('');

    $('closeDetails').addEventListener('click', closeDetails);
  } catch (err) {
    panel.innerHTML = `<div class="error-box">Не вдалося завантажити картку ОП.<br>${escapeHtml(err.message)}</div>`;
  }
}

function closeDetails() {
  state.selectedId = null;
  const panel = $('detailsPanel');
  panel.className = 'details-card empty';
  panel.innerHTML = `<div class="empty-state"><div class="empty-icon">⌘</div><h3>Оберіть освітню програму</h3><p>Тут з’явиться картка ОП, її професійні кваліфікації та інформація про поширення.</p></div>`;
  renderTable();
}

function levelLabel(id) { const x = state.levels.get(id); return x?.nameUk || id || '—'; }
function unitLabel(id, fallback) { const x = state.units.get(id); return x?.shortNameUk || x?.nameUk || fallback || '—'; }
function programTypeLabel(type) { return ({ professional: 'Освітньо-професійна', scientific: 'Освітньо-наукова', unspecified: '' })[type] || ''; }
function statusBadge(p) {
  if (p.qualificationStatus === 'mixed') return '<span class="badge purple">Погоджено + поширено</span>';
  if (p.qualificationStatus === 'extended') return '<span class="badge purple">Поширено</span>';
  if (p.qualificationStatus === 'approved') return '<span class="badge green">Погоджено</span>';
  return '<span class="badge subtle">Без ПК</span>';
}
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escapeAttr(v) { return escapeHtml(v).replace(/'/g, '&#39;'); }

init();
