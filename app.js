const PATHS = {
  index: './data/index.json',
  levels: './data/references/education-levels.json',
  units: './data/references/units.json',
  specialties: './data/references/specialties.json',
  qualifications: './data/references/qualifications.json',
  successions: './data/program-successions.json',
  program: id => `./data/references/programs/${normalizeEdeboId(id)}.json`,
  programQualifications: id => `./data/references/program-qualifications/${normalizeEdeboId(id)}.json`
};

const REPO_PATHS = {
  index: 'data/index.json',
  qualifications: 'data/references/qualifications.json',
  program: id => `data/references/programs/${normalizeEdeboId(id)}.json`,
  programQualifications: id => `data/references/program-qualifications/${normalizeEdeboId(id)}.json`
};

const state = {
  indexDoc: null,
  index: [],
  filtered: [],
  levels: new Map(),
  units: new Map(),
  specialties: new Map(),
  qualifications: new Map(),
  successions: [],
  successionBySource: new Map(),
  successionByTarget: new Map(),
  currentPage: 1,
  pageSize: 20,
  sortKey: 'nameUk',
  sortDirection: 'asc',
  selectedId: null,
  selectedProgram: null,
  selectedRelations: null,
  view: 'programs',
  editor: false,
  github: {
    owner: localStorage.getItem('pqGithubOwner') || 'omelchukll',
    repo: localStorage.getItem('pqGithubRepo') || 'ProfessionalQualification',
    branch: localStorage.getItem('pqGithubBranch') || 'main',
    token: sessionStorage.getItem('pqGithubToken') || ''
  }
};

const $ = id => document.getElementById(id);

async function getJson(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function unwrapArray(doc, key) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc[key])) return doc[key];
  return [];
}

function normalizeEdeboId(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const raw = String(value).trim();

  // Відомі виправлення з вихідного Excel
  if (raw.includes('15829') && raw.includes('2183')) return 2183;
  if (raw.includes('23388') && raw.includes('23368')) return 23368;

  // Якщо ID уже нормальний
  if (/^\d+$/.test(raw)) return Number(raw);
  if (/^\d+\.0$/.test(raw)) return Number(raw.slice(0, -2));

  // Загальний випадок: "... правильне ID 12345"
  const matches = [...raw.matchAll(/правильн\p{L}*\s*(?:іd|id)\D*(\d+)/giu)];
  if (matches.length) {
    return Number(matches[matches.length - 1][1]);
  }

  return value;
}

function normalizeIndexProgramIds(programs) {
  return programs.map(p => {
    const normalized = normalizeEdeboId(p.edeboId);
    if (String(normalized) === String(p.edeboId)) return p;

    const copy = { ...p };
    copy.sourceEdeboIdRaw = p.edeboId;
    copy.edeboId = normalized;
    copy.programId = `program-${normalized}`;
    copy.searchText = String(copy.searchText || '')
      .replace(String(p.edeboId).toLocaleLowerCase('uk-UA'), String(normalized));
    return copy;
  });
}

function decodeBase64Utf8(value) {
  const binary = atob((value || '').replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function githubApiUrl(path) {
  const p = path.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${encodeURIComponent(state.github.owner)}/${encodeURIComponent(state.github.repo)}/contents/${p}`;
}

async function githubRequest(path, options = {}) {
  if (!state.github.token) throw new Error('Спочатку підключіть режим редагування.');
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${state.github.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {})
  };
  const res = await fetch(path.startsWith('http') ? path : githubApiUrl(path), { ...options, headers });
  if (res.status === 204) return null;
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const message = body?.message || `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function readRepoJson(path) {
  const data = await githubRequest(`${githubApiUrl(path)}?ref=${encodeURIComponent(state.github.branch)}`);
  return { json: JSON.parse(decodeBase64Utf8(data.content)), sha: data.sha };
}

async function writeRepoJson(path, json, message, expectedSha = null) {
  let sha = expectedSha;
  if (sha === null) {
    try {
      const current = await readRepoJson(path);
      sha = current.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  const payload = {
    message,
    content: encodeBase64Utf8(JSON.stringify(json, null, 2) + '\n'),
    branch: state.github.branch
  };
  if (sha) payload.sha = sha;
  return githubRequest(path, { method: 'PUT', body: JSON.stringify(payload) });
}

async function deleteRepoFile(path, message) {
  let current;
  try { current = await readRepoJson(path); }
  catch (err) { if (err.status === 404) return; throw err; }
  return githubRequest(path, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha: current.sha, branch: state.github.branch })
  });
}

async function updateRepoJsonWithRetry(path, mutate, message, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const current = await readRepoJson(path);
    const next = await mutate(structuredClone(current.json));
    try {
      await writeRepoJson(path, next, message, current.sha);
      return next;
    } catch (err) {
      if ((err.status === 409 || err.status === 422) && attempt < retries) continue;
      throw err;
    }
  }
}

async function init() {
  try {
    const [indexDoc, levelsDoc, unitsDoc, specialtiesDoc, qualificationsDoc, successionsDoc] = await Promise.all([
      getJson(PATHS.index), getJson(PATHS.levels), getJson(PATHS.units),
      getJson(PATHS.specialties), getJson(PATHS.qualifications),
      getJson(PATHS.successions).catch(() => ({ relations: [] }))
    ]);

    state.indexDoc = indexDoc;
    state.index = normalizeIndexProgramIds(unwrapArray(indexDoc, 'programs'));
    state.index.filter(p => p.sourceEdeboIdRaw).forEach(p =>
      console.warn('Normalized legacy EDEBO ID:', p.sourceEdeboIdRaw, '→', p.edeboId)
    );
    unwrapArray(levelsDoc, 'educationLevels').forEach(x => state.levels.set(x.id, x));
    unwrapArray(unitsDoc, 'units').forEach(x => state.units.set(x.id, x));
    unwrapArray(specialtiesDoc, 'specialties').forEach(x => state.specialties.set(x.id, x));
    unwrapArray(qualificationsDoc, 'qualifications').forEach(x => state.qualifications.set(x.id, x));
    state.successions = unwrapArray(successionsDoc, 'relations');
    state.successionBySource.clear();
    state.successionByTarget.clear();
    state.successions.forEach(rel => {
      const sourceId = String(rel.sourceProgram?.edeboId ?? String(rel.sourceProgramId || '').replace('program-', ''));
      const targetId = String(rel.targetProgram?.edeboId ?? String(rel.targetProgramId || '').replace('program-', ''));
      if (sourceId) {
        if (!state.successionBySource.has(sourceId)) state.successionBySource.set(sourceId, []);
        state.successionBySource.get(sourceId).push(rel);
      }
      if (targetId) {
        if (!state.successionByTarget.has(targetId)) state.successionByTarget.set(targetId, []);
        state.successionByTarget.get(targetId).push(rel);
      }
    });

    if (!state.levels.size && Array.isArray(levelsDoc)) levelsDoc.forEach(x => state.levels.set(x.id, x));
    if (!state.units.size && Array.isArray(unitsDoc)) unitsDoc.forEach(x => state.units.set(x.id, x));

    fillReferenceFilters();
    bindEvents();
    updateStats();
    setEditorMode(Boolean(state.github.token), false);
    applyFilters();
    $('dataStatus').textContent = `Дані завантажено: ${state.index.length} ОП`;
  } catch (err) {
    console.error(err);
    $('dataStatus').textContent = 'Помилка завантаження';
    document.querySelector('.content').innerHTML = `
      <div class="error-box"><strong>Не вдалося завантажити JSON.</strong><br><br>
      ${escapeHtml(err.message)}</div>`;
  }
}

function fillReferenceFilters() {
  const levelSelect = $('filterLevel');
  [...state.levels.values()].sort((a,b) => (a.order ?? 999) - (b.order ?? 999))
    .forEach(x => levelSelect.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(x.id)}">${escapeHtml(x.nameUk || x.name || x.id)}</option>`));

  const unitSelect = $('filterUnit');
  [...state.units.values()].filter(x => x.active !== false).sort((a,b) => (a.order ?? 999) - (b.order ?? 999))
    .forEach(x => unitSelect.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(x.id)}">${escapeHtml(x.shortNameUk || x.nameUk || x.id)}</option>`));
}

function bindEvents() {
  ['globalSearch','filterListYear','filterLevel','filterUnit','filterQualificationStatus','filterHasQualifications']
    .forEach(id => $(id).addEventListener(id === 'globalSearch' ? 'input' : 'change', () => {
      state.currentPage = 1; applyFilters();
    }));

  $('pageSize').addEventListener('change', e => {
    state.pageSize = Number(e.target.value); state.currentPage = 1; renderTable();
  });
  $('resetFilters').addEventListener('click', () => {
    $('globalSearch').value = '';
    ['filterListYear','filterLevel','filterUnit','filterQualificationStatus','filterHasQualifications'].forEach(id => $(id).value = '');
    state.currentPage = 1; applyFilters();
  });
  $('prevPage').addEventListener('click', () => { if (state.currentPage > 1) { state.currentPage--; renderTable(); } });
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
    state.view = btn.dataset.view; state.currentPage = 1; applyFilters();
  }));

  $('exportExcelBtn').addEventListener('click', openExportExcelModal);
  $('githubSettings').addEventListener('click', openGithubSettings);
  $('addProgramBtn').addEventListener('click', () => openProgramForm());
  $('addQualificationBtn').addEventListener('click', () => openQualificationForm());
  $('modalClose').addEventListener('click', closeModal);
  $('modalBackdrop').addEventListener('click', e => { if (e.target === $('modalBackdrop')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

function setEditorMode(on, toast = true) {
  state.editor = on;
  document.body.classList.toggle('editor-enabled', on);
  $('editState').textContent = on ? 'Редагування увімкнено' : 'Лише перегляд';
  $('editState').className = `edit-state ${on ? 'editing' : 'readonly'}`;
  $('githubSettings').textContent = on ? 'GitHub ✓' : 'Редагування';
  if (toast) showToast(on ? 'Режим редагування увімкнено.' : 'Режим редагування вимкнено.', 'success');
}

function updateStats() {
  const all = state.index.length;
  $('statAll').textContent = all;
  $('statWith').textContent = state.index.filter(x => x.hasQualifications).length;
  $('statExtended').textContent = state.index.filter(x => x.hasExtendedQualifications).length;
  $('statWithout').textContent = state.index.filter(x => !x.hasQualifications).length;
}

function applyFilters() {
  const q = $('globalSearch').value.trim().toLocaleLowerCase('uk-UA');
  const year = $('filterListYear').value;
  const level = $('filterLevel').value;
  const unit = $('filterUnit').value;
  const qStatus = $('filterQualificationStatus').value;
  const hasQ = $('filterHasQualifications').value;

  state.filtered = state.index.filter(p => {
    if (p.status === 'deleted') return false;
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
    const av = a[state.sortKey] ?? '', bv = b[state.sortKey] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av-bv) * dir;
    return String(av).localeCompare(String(bv), 'uk', { numeric: true, sensitivity: 'base' }) * dir;
  });
}

function successionRelationForProgram(edeboId) {
  const id = String(edeboId);
  const asSource = state.successionBySource.get(id) || [];
  if (asSource.length) return asSource[0];
  const asTarget = state.successionByTarget.get(id) || [];
  return asTarget.length ? asTarget[0] : null;
}

function successionIdsForProgram(edeboId) {
  const rel = successionRelationForProgram(edeboId);
  if (!rel) return { relation: null, sourceId: null, targetId: null };
  const sourceId = String(rel.sourceProgram?.edeboId ?? String(rel.sourceProgramId || '').replace('program-', ''));
  const targetId = String(rel.targetProgram?.edeboId ?? String(rel.targetProgramId || '').replace('program-', ''));
  return { relation: rel, sourceId, targetId };
}

function sameLogicalProgram(a, b) {
  if (String(a) === String(b)) return true;
  const ga = successionIdsForProgram(a);
  return Boolean(ga.relation && (String(b) === ga.sourceId || String(b) === ga.targetId));
}

function logicalRowsFromFiltered(rows) {
  const groups = new Map();
  const yearFilter = $('filterListYear').value;

  for (const p of rows) {
    const g = successionIdsForProgram(p.edeboId);
    const key = g.relation ? `succ:${g.sourceId}:${g.targetId}` : `single:${p.edeboId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const result = [];
  for (const candidates of groups.values()) {
    if (candidates.length === 1) {
      result.push(candidates[0]);
      continue;
    }

    let chosen = null;

    // If the user explicitly filtered by classifier year, show that version.
    if (yearFilter) {
      chosen = candidates.find(p => String(p.listYear) === String(yearFilter));
    }

    // Otherwise the logical card starts from the previous/old program.
    if (!chosen) {
      chosen = candidates.find(p => {
        const g = successionIdsForProgram(p.edeboId);
        return g.sourceId && String(p.edeboId) === g.sourceId;
      });
    }

    result.push(chosen || candidates[0]);
  }
  return result;
}

function renderProgramVersionSwitch(edeboId) {
  const host = $('programVersionSwitch');
  if (!host) return;

  const { relation, sourceId, targetId } = successionIdsForProgram(edeboId);
  if (!relation || !sourceId || !targetId) {
    host.innerHTML = '';
    host.style.display = 'none';
    return;
  }

  host.style.display = '';
  const current = String(edeboId);
  const sourceSummary = relation.sourceProgram || {};
  const targetSummary = relation.targetProgram || {};

  const sourceYear = sourceSummary.classifierId === 'specialties-2015' ? '2015' :
                     sourceSummary.classifierId === 'specialties-2024' ? '2024' : 'старий';
  const targetYear = targetSummary.classifierId === 'specialties-2024' ? '2024' :
                     targetSummary.classifierId === 'specialties-2015' ? '2015' : 'новий';

  host.innerHTML = `
    <div class="program-version-box">
      <div class="program-version-caption">Версії освітньої програми</div>
      <div class="program-version-tabs">
        <button type="button"
                class="program-version-tab ${current === sourceId ? 'active' : ''}"
                data-program-version="${escapeAttr(sourceId)}">
          <span class="version-kicker">Попередній перелік</span>
          <strong>${escapeHtml(sourceYear)}</strong>
          <small>ID ${escapeHtml(sourceId)}</small>
        </button>
        <div class="version-connector" aria-hidden="true">→</div>
        <button type="button"
                class="program-version-tab ${current === targetId ? 'active' : ''}"
                data-program-version="${escapeAttr(targetId)}">
          <span class="version-kicker">Новий перелік</span>
          <strong>${escapeHtml(targetYear)}</strong>
          <small>ID ${escapeHtml(targetId)}</small>
        </button>
      </div>
      <div class="program-version-note">
        Це одна логічна послідовність ОП. Перемикач змінює версію, а не відкриває окрему картку.
      </div>
    </div>`;

  host.querySelectorAll('[data-program-version]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.programVersion;
      if (id && id !== current) openDetails(id, { preserveLogicalCard: true });
    });
  });
}

function renderTable() {
  const rows = sortedRows(logicalRowsFromFiltered(state.filtered));
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  if (state.currentPage > pages) state.currentPage = pages;
  const start = (state.currentPage - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  $('visibleCount').textContent = `${rows.length} карток`;

  $('programRows').innerHTML = pageRows.map(p => {
    const g = successionIdsForProgram(p.edeboId);
    const linked = Boolean(g.relation);
    const versionBadge = linked
      ? `<div class="cell-sub logical-pair-note">Пов’язана ОП: ${escapeHtml(g.sourceId)} → ${escapeHtml(g.targetId)}</div>`
      : '';

    return `
    <tr data-id="${escapeAttr(p.edeboId)}" class="${sameLogicalProgram(state.selectedId, p.edeboId) ? 'selected' : ''}">
      <td><span class="cell-title">${escapeHtml(p.edeboId)}</span>${linked ? '<div class="cell-sub">є наступність</div>' : ''}</td>
      <td><div class="cell-title">${escapeHtml(p.nameUk || '—')}</div><div class="cell-sub">${escapeHtml(programTypeLabel(p.programType))}</div>${versionBadge}</td>
      <td><div class="cell-title">${escapeHtml(p.specialtyCodeRaw || '—')}</div><div class="cell-sub">${escapeHtml(p.specialtyNameUk || '')}</div></td>
      <td>${escapeHtml(levelLabel(p.educationLevelId))}</td>
      <td>${escapeHtml(unitLabel(p.unitId, p.unitNameUk))}</td>
      <td><span class="badge ${p.qualificationCount ? 'green' : 'subtle'}">${p.qualificationCount ?? 0}</span></td>
      <td>${statusBadge(p)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">Нічого не знайдено.</td></tr>`;

  document.querySelectorAll('#programRows tr[data-id]').forEach(tr => tr.addEventListener('click', () => openDetails(tr.dataset.id)));
  $('pageInfo').textContent = `${state.currentPage} / ${pages}`;
  $('prevPage').disabled = state.currentPage <= 1;
  $('nextPage').disabled = state.currentPage >= pages;
}

async function openDetails(edeboId, options = {}) {
  edeboId = normalizeEdeboId(edeboId);
  state.selectedId = String(edeboId);
  renderTable();
  const panel = $('detailsPanel');
  panel.classList.remove('empty');
  panel.innerHTML = `<div class="muted">Завантаження картки…</div>`;

  try {
    const indexEntry = state.index.find(x => String(x.edeboId) === String(edeboId));
    const [program, pq] = await Promise.all([
      getJson(PATHS.program(edeboId)),
      getJson(PATHS.programQualifications(edeboId)).catch(() => ({ programId: `program-${edeboId}`, edeboId: Number(edeboId), qualifications: [] }))
    ]);
    state.selectedProgram = program;
    state.selectedRelations = pq;

    const tpl = $('detailsTemplate').content.cloneNode(true);
    panel.innerHTML = ''; panel.appendChild(tpl);

    $('detailName').textContent = program.nameUk || indexEntry?.nameUk || 'Без назви';
    $('detailId').textContent = `ID ОП: ${program.edeboId ?? edeboId}`;

    const specialties = (program.specialtyIds || []).map(id => state.specialties.get(id)).filter(Boolean);
    const specialtyText = specialties.length ? specialties.map(x => `${x.code} ${x.nameUk}`).join('; ')
      : [program.specialtyCodeRaw, program.specialtyNameRaw].filter(Boolean).join(' ');

    $('detailMeta').innerHTML = [
      ['Перелік', program.classifierId === 'specialties-2024' ? '2024' : program.classifierId === 'specialties-2015' ? '2015' : '—'],
      ['Спеціальність', specialtyText || '—'],
      ['Рівень', levelLabel(program.educationLevelId)],
      ['Підрозділ', unitLabel(program.unitId, program.unitNameRaw)],
      ['Форма', program.studyForm || '—']
    ].map(([label,val]) => `<div class="meta-row"><div class="meta-label">${escapeHtml(label)}</div><div>${escapeHtml(val)}</div></div>`).join('');

    renderProgramVersionSwitch(edeboId);
    renderDetailsRelations(pq.qualifications || []);

    $('closeDetails').addEventListener('click', closeDetails);
    $('editProgramBtn')?.addEventListener('click', () => openProgramForm(program));
    $('deleteProgramBtn')?.addEventListener('click', () => deleteProgram(program));
    $('addRelationBtn')?.addEventListener('click', () => openRelationForm(program, pq));
  } catch (err) {
    panel.innerHTML = `<div class="error-box">Не вдалося завантажити картку ОП.<br>${escapeHtml(err.message)}</div>`;
  }
}

function formatSuccessionSpecialty(programSummary) {
  const codes = programSummary?.specialtyCodes || [];
  const names = programSummary?.specialtyNamesUk || [];
  if (!codes.length && !names.length) return '';
  const max = Math.max(codes.length, names.length);
  const parts = [];
  for (let i = 0; i < max; i++) {
    parts.push([codes[i], names[i]].filter(Boolean).join(' '));
  }
  return parts.filter(Boolean).join('; ');
}

function renderDetailsRelations(rels) {
  const indexEntry = state.index.find(x => String(x.edeboId) === String(state.selectedId));
  $('detailQualificationCount').textContent = `${rels.length} ПК`;
  $('detailQualifications').innerHTML = rels.length ? rels.map((r, i) => {
    const q = state.qualifications.get(r.qualificationId) || indexEntry?.qualifications?.find(x => x.id === r.qualificationId);
    const type = r.relationType === 'extended' ? '<span class="badge purple">Поширено</span>' : '<span class="badge green">Погоджено</span>';
    const order = r.relationType === 'extended' ? r.extension?.order : r.approval?.order;
    return `<div class="qualification-item">
      <div class="qualification-row">
        <div>
          <div class="qualification-title">${escapeHtml(q?.nameUk || r.sourceQualificationText || r.qualificationId)}</div>
          ${q?.nameEn ? `<div class="qualification-en">${escapeHtml(q.nameEn)}</div>` : ''}
        </div>
        <div class="item-actions editor-only">
          <button class="mini-btn edit-rel" data-index="${i}">✎</button>
          <button class="mini-btn danger-text delete-rel" data-index="${i}">×</button>
        </div>
      </div>
      <div class="qualification-meta">${type}${order?.raw ? `<span class="badge subtle">${escapeHtml(order.raw)}</span>` : ''}</div>
    </div>`;
  }).join('') : '<div class="muted">Професійні кваліфікації не зафіксовані.</div>';

  document.querySelectorAll('.edit-rel').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const rel = state.selectedRelations.qualifications[Number(btn.dataset.index)];
    openRelationForm(state.selectedProgram, state.selectedRelations, rel);
  }));
  document.querySelectorAll('.delete-rel').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const rel = state.selectedRelations.qualifications[Number(btn.dataset.index)];
    await deleteRelation(state.selectedProgram, rel);
  }));

  const ext = rels.filter(r => r.relationType === 'extended');
  if (!ext.length) $('extensionSection').style.display = 'none';
  else {
    $('extensionSection').style.display = '';
    $('detailExtensions').innerHTML = ext.map(r => `<div class="extension-item">
      <div><strong>Джерело:</strong> ${escapeHtml(r.sourceProgramId || '—')}</div>
      <div class="muted" style="margin-top:6px">${escapeHtml(r.extension?.order?.raw || 'Наказ не зазначено')}</div>
    </div>`).join('');
  }
}

function closeDetails() {
  state.selectedId = null; state.selectedProgram = null; state.selectedRelations = null;
  const panel = $('detailsPanel');
  panel.className = 'details-card empty';
  panel.innerHTML = `<div class="empty-state"><div class="empty-icon">⌘</div><h3>Оберіть освітню програму</h3><p>Тут з’явиться картка ОП, її професійні кваліфікації та інформація про поширення.</p></div>`;
  renderTable();
}

function openModal(title, bodyHtml, buttons = [], eyebrow = '') {
  $('modalEyebrow').textContent = eyebrow;
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  $('modalFoot').innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = `btn ${b.className || 'secondary'}`;
    btn.textContent = b.label;
    btn.addEventListener('click', b.onClick);
    $('modalFoot').appendChild(btn);
  }
  $('modalBackdrop').classList.remove('hidden');
}

function closeModal() { $('modalBackdrop').classList.add('hidden'); }

function openGithubSettings() {
  const connected = Boolean(state.github.token);
  openModal('Підключення GitHub', `
    <div class="form-grid one">
      <label><span>GitHub owner</span><input id="ghOwner" value="${escapeAttr(state.github.owner)}"></label>
      <label><span>Repository</span><input id="ghRepo" value="${escapeAttr(state.github.repo)}"></label>
      <label><span>Branch</span><input id="ghBranch" value="${escapeAttr(state.github.branch)}"></label>
      <label><span>Fine-grained personal access token</span><input id="ghToken" type="password" value="${escapeAttr(state.github.token)}" autocomplete="off"></label>
    </div>
    <div class="info-box">
      Token зберігається лише в <strong>sessionStorage</strong> цього браузера й зникає після завершення сесії.
      Для репозиторію потрібен дозвіл <strong>Contents: Read and write</strong>.
    </div>`,
    [
      ...(connected ? [{ label: 'Вимкнути редагування', className: 'danger', onClick: () => {
        sessionStorage.removeItem('pqGithubToken'); state.github.token = ''; setEditorMode(false); closeModal();
      }}] : []),
      { label: 'Перевірити й підключити', className: 'primary', onClick: connectGithub }
    ],
    'Редагування даних'
  );
}

async function connectGithub() {
  state.github.owner = $('ghOwner').value.trim();
  state.github.repo = $('ghRepo').value.trim();
  state.github.branch = $('ghBranch').value.trim() || 'main';
  state.github.token = $('ghToken').value.trim();
  if (!state.github.owner || !state.github.repo || !state.github.token) return showToast('Заповніть owner, repository і token.', 'error');

  try {
    setBusy(true, 'Перевіряю доступ…');
    await readRepoJson(REPO_PATHS.index);
    localStorage.setItem('pqGithubOwner', state.github.owner);
    localStorage.setItem('pqGithubRepo', state.github.repo);
    localStorage.setItem('pqGithubBranch', state.github.branch);
    sessionStorage.setItem('pqGithubToken', state.github.token);
    setEditorMode(true, false);
    closeModal();
    showToast('GitHub підключено. Редагування увімкнено.', 'success');
  } catch (err) {
    showToast(`Не вдалося підключитися: ${err.message}`, 'error');
  } finally { setBusy(false); }
}

function specialtyOptions(classifierId, selectedIds = []) {
  return [...state.specialties.values()]
    .filter(s => s.classifierId === classifierId)
    .sort((a,b) => String(a.code).localeCompare(String(b.code), 'uk', {numeric:true}))
    .map(s => `<option value="${escapeAttr(s.id)}" ${selectedIds.includes(s.id) ? 'selected' : ''}>${escapeHtml(s.code)} — ${escapeHtml(s.nameUk)}</option>`)
    .join('');
}

function openProgramForm(program = null) {
  requireEditor();
  const edit = Boolean(program);
  const classifierId = program?.classifierId || 'specialties-2024';
  openModal(edit ? 'Редагувати освітню програму' : 'Додати освітню програму', `
    <form id="programForm" class="form-grid">
      <label><span>ID ОП ЄДЕБО *</span><input id="pfId" inputmode="numeric" value="${escapeAttr(program?.edeboId || '')}" ${edit ? 'readonly' : ''} required></label>
      <label class="wide"><span>Назва ОП *</span><input id="pfName" value="${escapeAttr(program?.nameUk || '')}" required></label>
      <label><span>Тип ОП</span><select id="pfType">
        ${option('professional','Освітньо-професійна',program?.programType)}
        ${option('scientific','Освітньо-наукова',program?.programType)}
        ${option('unspecified','Не визначено',program?.programType)}
      </select></label>
      <label><span>Перелік</span><select id="pfClassifier">
        ${option('specialties-2015','2015',classifierId)}
        ${option('specialties-2024','2024',classifierId)}
      </select></label>
      <label class="wide"><span>Спеціальність(і) *</span>
        <select id="pfSpecialties" multiple size="7">${specialtyOptions(classifierId, program?.specialtyIds || [])}</select>
        <small>Для кількох спеціальностей використовуйте Ctrl + клік.</small>
      </label>
      <label><span>Рівень освіти *</span><select id="pfLevel">${[...state.levels.values()].map(x => option(x.id, x.nameUk, program?.educationLevelId)).join('')}</select></label>
      <label><span>Підрозділ *</span><select id="pfUnit">${[...state.units.values()].filter(x=>x.active!==false).map(x => option(x.id, x.shortNameUk || x.nameUk, program?.unitId)).join('')}</select></label>
      <label><span>Форма навчання</span><input id="pfStudyForm" value="${escapeAttr(program?.studyForm || '')}"></label>
      <label><span>Обсяг / тривалість</span><input id="pfVolume" value="${escapeAttr(program?.volumeAndDuration || '')}"></label>
    </form>`,
    [
      { label: 'Скасувати', onClick: closeModal },
      { label: edit ? 'Зберегти' : 'Створити', className: 'primary', onClick: () => saveProgram(program) }
    ],
    edit ? 'Картка ОП' : 'Нова ОП'
  );

  $('pfClassifier').addEventListener('change', () => {
    $('pfSpecialties').innerHTML = specialtyOptions($('pfClassifier').value, []);
  });
}

async function saveProgram(existing) {
  try {
    requireEditor();
    const id = $('pfId').value.trim();
    const name = $('pfName').value.trim();
    const specialtyIds = [...$('pfSpecialties').selectedOptions].map(x => x.value);
    if (!/^\d+$/.test(id)) throw new Error('ID ОП має бути числом.');
    if (!name) throw new Error('Вкажіть назву ОП.');
    if (!specialtyIds.length) throw new Error('Оберіть щонайменше одну спеціальність.');

    if (!existing && state.index.some(x => String(x.edeboId) === id)) throw new Error('ОП з таким ID уже існує.');

    const specs = specialtyIds.map(x => state.specialties.get(x)).filter(Boolean);
    const program = {
      ...(existing || {}),
      id: `program-${id}`,
      edeboId: Number(id),
      nameUk: name,
      programLabel: $('pfType').value === 'professional' ? 'ОПП' : $('pfType').value === 'scientific' ? 'ОНП' : null,
      programType: $('pfType').value,
      classifierId: $('pfClassifier').value,
      specialtyIds,
      specializationCodes: existing?.specializationCodes || [],
      specialtyCodeRaw: specs.map(x => x.code).join(' '),
      specialtyNameRaw: specs.map(x => x.nameUk).join('; '),
      educationLevelId: $('pfLevel').value,
      unitId: $('pfUnit').value,
      unitNameRaw: state.units.get($('pfUnit').value)?.nameUk || null,
      studyForm: $('pfStudyForm').value.trim() || null,
      volumeAndDuration: $('pfVolume').value.trim() || null,
      status: 'active',
      metadataOrigin: existing?.metadataOrigin || 'manual',
      updatedAt: new Date().toISOString()
    };

    setBusy(true, 'Зберігаю ОП…');
    await writeRepoJson(REPO_PATHS.program(id), program, `${existing ? 'Update' : 'Add'} program ${id}`);

    let pq;
    try { pq = (await readRepoJson(REPO_PATHS.programQualifications(id))).json; }
    catch (err) {
      if (err.status !== 404) throw err;
      pq = { programId: `program-${id}`, edeboId: Number(id), qualifications: [], sourceRows: [] };
      await writeRepoJson(REPO_PATHS.programQualifications(id), pq, `Create qualification file for program ${id}`);
    }

    const entry = buildIndexEntry(program, pq);
    await upsertIndexEntry(entry, `${existing ? 'Update' : 'Add'} program ${id} in index`);
    closeModal();
    await reloadData();
    await openDetails(id);
    showToast(existing ? 'ОП оновлено.' : 'ОП створено.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally { setBusy(false); }
}

async function deleteProgram(program) {
  requireEditor();
  const id = String(program.edeboId);
  const sourceRef = `program-${id}`;
  const usedAsSource = state.index.filter(p => (p.extensionSourceProgramIds || []).includes(sourceRef));
  if (usedAsSource.length) {
    return showToast(`Не можна видалити: ОП є джерелом поширення для ${usedAsSource.length} ОП.`, 'error');
  }
  if (!confirm(`Видалити ОП ${id} «${program.nameUk}» та її файл зв’язків із ПК?\n\nЦю дію можна відновити лише через історію Git.`)) return;

  try {
    setBusy(true, 'Видаляю ОП…');
    await deleteRepoFile(REPO_PATHS.program(id), `Delete program ${id}`);
    await deleteRepoFile(REPO_PATHS.programQualifications(id), `Delete program qualifications ${id}`);
    await updateRepoJsonWithRetry(REPO_PATHS.index, doc => {
      doc.programs = unwrapArray(doc, 'programs').filter(x => String(x.edeboId) !== id);
      return recalcIndexMeta(doc);
    }, `Remove program ${id} from index`);
    closeDetails();
    await reloadData();
    showToast('ОП видалено.', 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

function qualificationOptions(selected) {
  return [...state.qualifications.values()].filter(x => x.active !== false)
    .sort((a,b) => a.nameUk.localeCompare(b.nameUk, 'uk'))
    .map(q => option(q.id, `${q.nameUk}${q.nameEn ? ` / ${q.nameEn}` : ''}`, selected)).join('');
}

function openRelationForm(program, pqDoc, relation = null) {
  requireEditor();
  const edit = Boolean(relation);
  openModal(edit ? 'Редагувати професійну кваліфікацію ОП' : 'Додати ПК до ОП', `
    <form id="relationForm" class="form-grid">
      <label class="wide"><span>Професійна кваліфікація *</span>
        <select id="rfQualification">${qualificationOptions(relation?.qualificationId)}</select>
      </label>
      <label><span>Тип</span><select id="rfType">
        ${option('approved','Первинно погоджено',relation?.relationType || 'approved')}
        ${option('extended','Поширено',relation?.relationType)}
      </select></label>
      <label><span>Обов’язкова / вибіркова</span><select id="rfMandatory">
        ${option('','—',relation?.mandatoryOrElectiveSourceValue || '')}
        ${option('Обов’язкова','Обов’язкова',relation?.mandatoryOrElectiveSourceValue)}
        ${option('Вибіркова','Вибіркова',relation?.mandatoryOrElectiveSourceValue)}
      </select></label>
      <div class="wide conditional approved-fields">
        <div class="form-grid">
          <label><span>Наказ про погодження</span><input id="rfApprovalOrder" value="${escapeAttr(relation?.approval?.order?.raw || '')}" placeholder="№ 123-32 від 01.02.2026"></label>
          <label><span>Рішення НАК / сертифікат</span><input id="rfNak" value="${escapeAttr(relation?.approval?.nakDecisionOrCertificate || '')}"></label>
        </div>
      </div>
      <div class="wide conditional extended-fields">
        <div class="form-grid">
          <label><span>ID вихідної ОП *</span><input id="rfSourceProgram" value="${escapeAttr((relation?.sourceProgramId || '').replace('program-',''))}"></label>
          <label><span>Наказ про поширення</span><input id="rfExtensionOrder" value="${escapeAttr(relation?.extension?.order?.raw || '')}" placeholder="№ 876-32 від 14.07.2026"></label>
        </div>
      </div>
    </form>`,
    [
      { label: 'Скасувати', onClick: closeModal },
      { label: 'Зберегти', className: 'primary', onClick: () => saveRelation(program, pqDoc, relation) }
    ],
    edit ? 'Зв’язок ОП ↔ ПК' : `ОП ${program.edeboId}`
  );
  const toggle = () => {
    const ext = $('rfType').value === 'extended';
    document.querySelector('.approved-fields').style.display = ext ? 'none' : '';
    document.querySelector('.extended-fields').style.display = ext ? '' : 'none';
  };
  $('rfType').addEventListener('change', toggle); toggle();
}

async function saveRelation(program, pqDoc, oldRelation) {
  try {
    requireEditor();
    const qid = $('rfQualification').value;
    const type = $('rfType').value;
    const sourceId = $('rfSourceProgram')?.value.trim();
    if (type === 'extended' && !/^\d+$/.test(sourceId || '')) throw new Error('Для поширення вкажіть ID вихідної ОП.');

    const relation = {
      id: `rel-${program.edeboId}-${qid}`,
      qualificationId: qid,
      relationType: type,
      mandatoryOrElectiveSourceValue: $('rfMandatory').value || null,
      status: 'active',
      sourceRow: oldRelation?.sourceRow || null,
      sourceQualificationText: state.qualifications.get(qid)?.nameUk || qid
    };
    if (type === 'approved') {
      relation.approval = {
        order: parseOrderRaw($('rfApprovalOrder').value),
        nakDecisionOrCertificate: $('rfNak').value.trim() || null
      };
    } else {
      relation.sourceProgramId = `program-${sourceId}`;
      relation.sourceRelationId = `rel-${sourceId}-${qid}`;
      relation.extension = { order: parseOrderRaw($('rfExtensionOrder').value) };
    }

    setBusy(true, 'Зберігаю ПК…');
    const id = String(program.edeboId);
    const updatedPq = await updateRepoJsonWithRetry(REPO_PATHS.programQualifications(id), doc => {
      doc.programId = `program-${id}`;
      doc.edeboId = Number(id);
      doc.qualifications ||= [];
      if (oldRelation) {
        const idx = doc.qualifications.findIndex(x => x.id === oldRelation.id);
        if (idx >= 0) doc.qualifications[idx] = relation;
      } else {
        if (doc.qualifications.some(x => x.qualificationId === qid))
          throw new Error('Ця професійна кваліфікація вже додана до ОП.');
        doc.qualifications.push(relation);
      }
      return doc;
    }, `${oldRelation ? 'Update' : 'Add'} qualification ${qid} for program ${id}`);

    await upsertIndexEntry(buildIndexEntry(program, updatedPq), `Update index for program ${id}`);
    closeModal(); await reloadData(); await openDetails(id);
    showToast('Дані ПК збережено.', 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

async function deleteRelation(program, relation) {
  requireEditor();
  const q = state.qualifications.get(relation.qualificationId);
  if (!confirm(`Видалити зв’язок з ПК «${q?.nameUk || relation.qualificationId}» для ОП ${program.edeboId}?`)) return;
  try {
    setBusy(true, 'Видаляю зв’язок…');
    const id = String(program.edeboId);
    const updated = await updateRepoJsonWithRetry(REPO_PATHS.programQualifications(id), doc => {
      doc.qualifications = (doc.qualifications || []).filter(x => x.id !== relation.id);
      return doc;
    }, `Remove qualification ${relation.qualificationId} from program ${id}`);
    await upsertIndexEntry(buildIndexEntry(program, updated), `Update index for program ${id}`);
    await reloadData(); await openDetails(id);
    showToast('Зв’язок видалено.', 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

function openQualificationForm(q = null) {
  requireEditor();
  const edit = Boolean(q);
  openModal(edit ? 'Редагувати професійну кваліфікацію' : 'Додати професійну кваліфікацію', `
    <form class="form-grid one">
      <label><span>Назва українською *</span><input id="qfUk" value="${escapeAttr(q?.nameUk || '')}"></label>
      <label><span>Назва англійською</span><input id="qfEn" value="${escapeAttr(q?.nameEn || '')}"></label>
    </form>`,
    [
      { label: 'Скасувати', onClick: closeModal },
      ...(edit ? [{ label: 'Видалити', className: 'danger', onClick: () => deleteQualification(q) }] : []),
      { label: 'Зберегти', className: 'primary', onClick: () => saveQualification(q) }
    ],
    edit ? q.id : 'Довідник ПК'
  );
}

async function saveQualification(existing) {
  try {
    requireEditor();
    const uk = $('qfUk').value.trim(), en = $('qfEn').value.trim() || null;
    if (!uk) throw new Error('Вкажіть назву ПК.');
    const duplicate = [...state.qualifications.values()].find(x => x.id !== existing?.id && normalizeName(x.nameUk) === normalizeName(uk));
    if (duplicate) throw new Error(`Схожа ПК вже існує: ${duplicate.nameUk}.`);

    setBusy(true, 'Зберігаю довідник ПК…');
    let savedId = existing?.id;
    const nextDoc = await updateRepoJsonWithRetry(REPO_PATHS.qualifications, doc => {
      doc.qualifications ||= [];
      if (existing) {
        const idx = doc.qualifications.findIndex(x => x.id === existing.id);
        if (idx < 0) throw new Error('ПК не знайдено в актуальній версії довідника.');
        doc.qualifications[idx] = { ...doc.qualifications[idx], nameUk: uk, nameEn: en, active: true };
      } else {
        const max = doc.qualifications.reduce((m,x) => Math.max(m, Number(String(x.id).replace(/\D/g,'')) || 0), 0);
        savedId = `pq-${String(max + 1).padStart(4,'0')}`;
        doc.qualifications.push({ id: savedId, nameUk: uk, nameEn: en, active: true });
      }
      doc.count = doc.qualifications.length;
      return doc;
    }, `${existing ? 'Update' : 'Add'} qualification ${savedId || uk}`);

    state.qualifications.clear();
    unwrapArray(nextDoc, 'qualifications').forEach(x => state.qualifications.set(x.id, x));

    if (existing) {
      await updateRepoJsonWithRetry(REPO_PATHS.index, doc => {
        for (const p of unwrapArray(doc, 'programs')) {
          for (const iq of (p.qualifications || [])) {
            if (iq.id === existing.id) { iq.nameUk = uk; iq.nameEn = en; }
          }
          p.searchText = buildSearchText(p);
        }
        return recalcIndexMeta(doc);
      }, `Update qualification ${existing.id} in index`);
    }

    closeModal(); await reloadData();
    showToast(existing ? 'ПК оновлено.' : `ПК створено: ${savedId}.`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

async function deleteQualification(q) {
  requireEditor();
  const usedBy = state.index.filter(p => (p.qualifications || []).some(x => x.id === q.id));
  if (usedBy.length) return showToast(`Не можна видалити: ПК використовується у ${usedBy.length} ОП. Спочатку видаліть зв’язки.`, 'error');
  if (!confirm(`Видалити ПК «${q.nameUk}» з довідника?`)) return;
  try {
    setBusy(true, 'Видаляю ПК…');
    await updateRepoJsonWithRetry(REPO_PATHS.qualifications, doc => {
      doc.qualifications = (doc.qualifications || []).filter(x => x.id !== q.id);
      doc.count = doc.qualifications.length;
      return doc;
    }, `Delete qualification ${q.id}`);
    closeModal(); await reloadData(); showToast('ПК видалено.', 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { setBusy(false); }
}

function buildIndexEntry(program, pqDoc) {
  const rels = (pqDoc.qualifications || []).filter(x => x.status !== 'deleted');
  const approved = rels.filter(x => x.relationType === 'approved');
  const extended = rels.filter(x => x.relationType === 'extended');
  const seen = new Set(), qualifications = [];
  for (const r of rels) {
    if (seen.has(r.qualificationId)) continue;
    seen.add(r.qualificationId);
    const q = state.qualifications.get(r.qualificationId);
    qualifications.push({ id: r.qualificationId, nameUk: q?.nameUk || r.sourceQualificationText || r.qualificationId, nameEn: q?.nameEn || null });
  }
  const specs = (program.specialtyIds || []).map(x => state.specialties.get(x)).filter(Boolean);
  const entry = {
    programId: program.id,
    edeboId: program.edeboId,
    nameUk: program.nameUk,
    programType: program.programType,
    classifierId: program.classifierId,
    listYear: program.classifierId === 'specialties-2015' ? 2015 : program.classifierId === 'specialties-2024' ? 2024 : null,
    specialtyIds: program.specialtyIds || [],
    specializationCodes: program.specializationCodes || [],
    specialtyCodeRaw: program.specialtyCodeRaw || specs.map(x=>x.code).join(' '),
    specialtyNameUk: program.specialtyNameRaw || specs.map(x=>x.nameUk).join('; '),
    educationLevelId: program.educationLevelId,
    unitId: program.unitId,
    unitNameUk: program.unitNameRaw || state.units.get(program.unitId)?.nameUk || null,
    studyForm: program.studyForm || null,
    status: program.status || 'active',
    qualificationCount: qualifications.length,
    approvedQualificationCount: approved.length,
    extendedQualificationCount: extended.length,
    qualificationStatus: approved.length && extended.length ? 'mixed' : approved.length ? 'approved' : extended.length ? 'extended' : 'none',
    hasQualifications: qualifications.length > 0,
    hasApprovedQualifications: approved.length > 0,
    hasExtendedQualifications: extended.length > 0,
    qualifications,
    extensionSourceProgramIds: [...new Set(extended.map(x=>x.sourceProgramId).filter(Boolean))],
    metadataOrigin: program.metadataOrigin || 'manual'
  };
  entry.searchText = buildSearchText(entry);
  return entry;
}

function buildSearchText(p) {
  const parts = [p.edeboId,p.nameUk,p.specialtyCodeRaw,p.specialtyNameUk,p.educationLevelId,p.unitNameUk];
  for (const q of (p.qualifications || [])) parts.push(q.nameUk,q.nameEn);
  return parts.filter(Boolean).join(' ').toLocaleLowerCase('uk-UA');
}

async function upsertIndexEntry(entry, message) {
  const next = await updateRepoJsonWithRetry(REPO_PATHS.index, doc => {
    doc.programs ||= [];
    const idx = doc.programs.findIndex(x => String(x.edeboId) === String(entry.edeboId));
    if (idx >= 0) doc.programs[idx] = entry; else doc.programs.push(entry);
    doc.programs.sort((a,b) => String(a.nameUk||'').localeCompare(String(b.nameUk||''),'uk',{numeric:true}));
    return recalcIndexMeta(doc);
  }, message);
  state.indexDoc = next;
}

function recalcIndexMeta(doc) {
  const arr = unwrapArray(doc, 'programs');
  doc.programCount = arr.length;
  doc.programsWithQualifications = arr.filter(x=>x.hasQualifications).length;
  doc.programsWithoutQualifications = arr.filter(x=>!x.hasQualifications).length;
  doc.programsWithApprovedQualifications = arr.filter(x=>x.hasApprovedQualifications).length;
  doc.programsWithExtendedQualifications = arr.filter(x=>x.hasExtendedQualifications).length;
  return doc;
}

async function reloadData() {
  const [indexDoc, qualificationsDoc, successionsDoc] = await Promise.all([
    getJson(PATHS.index),
    getJson(PATHS.qualifications),
    getJson(PATHS.successions).catch(() => ({ relations: [] }))
  ]);
  state.indexDoc = indexDoc;
  state.index = normalizeIndexProgramIds(unwrapArray(indexDoc, 'programs'));
  state.qualifications.clear();
  unwrapArray(qualificationsDoc, 'qualifications').forEach(x => state.qualifications.set(x.id, x));
  state.successions = unwrapArray(successionsDoc, 'relations');
  state.successionBySource.clear();
  state.successionByTarget.clear();
  state.successions.forEach(rel => {
    const sourceId = String(rel.sourceProgram?.edeboId ?? String(rel.sourceProgramId || '').replace('program-', ''));
    const targetId = String(rel.targetProgram?.edeboId ?? String(rel.targetProgramId || '').replace('program-', ''));
    if (sourceId) {
      if (!state.successionBySource.has(sourceId)) state.successionBySource.set(sourceId, []);
      state.successionBySource.get(sourceId).push(rel);
    }
    if (targetId) {
      if (!state.successionByTarget.has(targetId)) state.successionByTarget.set(targetId, []);
      state.successionByTarget.get(targetId).push(rel);
    }
  });
  updateStats(); applyFilters();
}

function parseOrderRaw(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;
  const m = raw.match(/(?:№\s*)?(.+?)\s+від\s+(\d{2})\.(\d{2})\.(\d{4})$/i);
  if (!m) return { raw };
  return { number: m[1].trim(), date: `${m[4]}-${m[3]}-${m[2]}`, raw };
}

function requireEditor() {
  if (!state.editor || !state.github.token) {
    openGithubSettings();
    throw new Error('Режим редагування не підключено.');
  }
}



// ---------- Self-contained XLSX writer ----------
// Generates a standards-based .xlsx workbook directly in the browser.
// No CDN or external JavaScript library is required.

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function excelColumnName(index) {
  let n = index + 1, s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function makeWorksheetXml(aoa) {
  const widths = [10,18,30,46,18,18,16,24,34,24,20,20,58,24,38,20,32,12,46,28];
  const cols = widths.map((w, i) =>
    `<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`
  ).join('');

  const rows = aoa.map((row, rIdx) => {
    const cells = row.map((value, cIdx) => {
      const ref = `${excelColumnName(cIdx)}${rIdx + 1}`;
      const text = String(value ?? '');
      // Style 1: yellow header row; Style 2: normal body; Style 3: green first column.
      const styleId = rIdx === 0 ? 1 : (cIdx === 0 ? 3 : 2);
      const style = ` s="${styleId}"`;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
    }).join('');
    return `<row r="${rIdx + 1}"${rIdx === 0 ? ' ht="30" customHeight="1"' : ''}>${cells}</row>`;
  }).join('');

  const lastRow = Math.max(1, aoa.length);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:T${lastRow}"/>
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${cols}</cols>
  <sheetData>${rows}</sheetData>
  <autoFilter ref="A1:T${lastRow}"/>
</worksheet>`;
}

function makeStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment wrapText="1" horizontal="center" vertical="center"/>
    </xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">
      <alignment wrapText="1" vertical="top"/>
    </xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment wrapText="1" horizontal="center" vertical="center"/>
    </xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function crc32(bytes) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crc32.table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function le16(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255]);
}

function le32(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}

function concatBytes(parts) {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function zipStore(files) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dt = dosDateTime();

  for (const file of files) {
    const name = enc.encode(file.name);
    const data = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
    const crc = crc32(data);

    const local = concatBytes([
      le32(0x04034b50), le16(20), le16(0), le16(0), le16(dt.time), le16(dt.day),
      le32(crc), le32(data.length), le32(data.length), le16(name.length), le16(0),
      name, data
    ]);
    locals.push(local);

    const central = concatBytes([
      le32(0x02014b50), le16(20), le16(20), le16(0), le16(0), le16(dt.time), le16(dt.day),
      le32(crc), le32(data.length), le32(data.length), le16(name.length), le16(0), le16(0),
      le16(0), le16(0), le32(0), le32(offset), name
    ]);
    centrals.push(central);
    offset += local.length;
  }

  const centralBlock = concatBytes(centrals);
  const end = concatBytes([
    le32(0x06054b50), le16(0), le16(0), le16(files.length), le16(files.length),
    le32(centralBlock.length), le32(offset), le16(0)
  ]);
  return concatBytes([...locals, centralBlock, end]);
}

function downloadSimpleXlsx(aoa, filename, sheetName = 'Sheet1') {
  const safeSheet = String(sheetName).replace(/[\\/*?:[\]]/g, ' ').slice(0, 31) || 'Sheet1';
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xmlEscape(safeSheet)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    },
    { name: 'xl/styles.xml', data: makeStylesXml() },
    { name: 'xl/worksheets/sheet1.xml', data: makeWorksheetXml(aoa) }
  ];

  const bytes = zipStore(files);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}


// ---------- Excel export ----------
function openExportExcelModal() {
  const filteredCount = state.filtered.length;
  openModal('Експорт у Excel', `
    <div class="export-summary">
      <p>Файл формується у структурі, аналогічній вихідному реєстру A–T.</p>
      <div class="export-counts">
        <div><strong>${filteredCount}</strong><span>у поточній вибірці</span></div>
        <div><strong>${state.index.length}</strong><span>у всьому реєстрі</span></div>
      </div>
      <div class="info-box">
        Якщо ОП отримала ПК через поширення, у A–I виводиться вихідна ОП, а у P–T — нова ОП та наказ про поширення. Кілька ПК в одній клітинці розділяються крапкою з комою.
      </div>
    </div>`,
    [
      { label: 'Скасувати', onClick: closeModal },
      { label: `Поточна вибірка (${filteredCount})`, className: 'primary', onClick: () => exportProgramsToExcel(state.filtered) },
      { label: `Увесь реєстр (${state.index.length})`, className: 'secondary', onClick: () => exportProgramsToExcel(state.index) }
    ],
    'Експорт даних'
  );
}

async function exportProgramsToExcel(programEntries) {
  if (!programEntries.length) return showToast('Немає даних для експорту.', 'error');
  try {
    closeModal();
    setBusy(true, `Готую Excel: 0 / ${programEntries.length}`);

    const rows = await mapWithConcurrency(programEntries, 10, async (entry, index) => {
      $('dataStatus').textContent = `Готую Excel: ${index + 1} / ${programEntries.length}`;
      return buildLegacyExcelRow(entry);
    });

    const headers = [
      'ID ОП',
      'Код спеціальності',
      'Назва спеціальності',
      'Назва ОП',
      'Рівень освіти',
      'Ступінь',
      'Форма навчання',
      'Обсяг / тривалість',
      'Структурний підрозділ',
      'Наказ',
      'Стан формування пакета',
      'Стан відправлення пакета',
      'Зареєстрована ПК',
      'Обов’язкова / вибіркова',
      'Рішення НАК / сертифікат',
      'Код спеціальності (2024)',
      'Назва спеціальності (2024)',
      'Нове ID',
      'Нова назва ОП',
      'Наказ на поширення'
    ];

    const aoa = [headers, ...rows];
    const today = new Date();
    const stamp = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    const isAll = programEntries.length === state.index.length && programEntries.every((x,i) => x === state.index[i]);
    const filename = `ProfessionalQualifications_${isAll ? 'all' : 'filtered'}_${stamp}.xlsx`;

    downloadSimpleXlsx(aoa, filename, 'КНУТШ ПК');
    showToast(`Excel сформовано: ${rows.length} рядків.`, 'success');
  } catch (err) {
    console.error(err);
    showToast(`Не вдалося сформувати Excel: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function buildLegacyExcelRow(entry) {
  const id = String(normalizeEdeboId(entry.edeboId));
  const [program, pqDoc] = await Promise.all([
    getJson(PATHS.program(id)),
    getJson(PATHS.programQualifications(id)).catch(() => ({ qualifications: [] }))
  ]);
  const rels = (pqDoc.qualifications || []).filter(r => r.status !== 'deleted');
  const approved = rels.filter(r => r.relationType === 'approved');
  const extended = rels.filter(r => r.relationType === 'extended');

  // For a target program whose qualifications were extended, reconstruct the legacy A–T row:
  // source program in A–I and target program in P–T.
  if (extended.length && !approved.length) {
    const sourceProgramId = (extended.find(r => r.sourceProgramId)?.sourceProgramId || '').replace('program-', '');
    let sourceProgram = program;
    let sourcePq = { qualifications: [] };
    if (sourceProgramId) {
      [sourceProgram, sourcePq] = await Promise.all([
        getJson(PATHS.program(sourceProgramId)).catch(() => program),
        getJson(PATHS.programQualifications(sourceProgramId)).catch(() => ({ qualifications: [] }))
      ]);
    }
    const sourceApproved = (sourcePq.qualifications || []).filter(r => r.relationType === 'approved' && r.status !== 'deleted');
    return legacyRowFromParts(sourceProgram, sourceApproved.length ? sourceApproved : extended, program, extended);
  }

  // Directly approved program (including programs already under the 2024 list).
  return legacyRowFromParts(program, approved.length ? approved : rels, null, []);
}

function legacyRowFromParts(sourceProgram, sourceRelations, targetProgram, extensionRelations) {
  const qNames = unique(sourceRelations.map(r => qualificationName(r.qualificationId, r.sourceQualificationText)));
  const approvalOrders = unique(sourceRelations.map(r => formatOrder(r.approval?.order)).filter(Boolean));
  const mandatory = unique(sourceRelations.map(r => r.mandatoryOrElectiveSourceValue).filter(Boolean));
  const nak = unique(sourceRelations.map(r => r.approval?.nakDecisionOrCertificate).filter(Boolean));

  const targetSpecs = targetProgram ? (targetProgram.specialtyIds || []).map(id => state.specialties.get(id)).filter(Boolean) : [];
  const extensionOrders = unique(extensionRelations.map(r => formatOrder(r.extension?.order)).filter(Boolean));

  return [
    sourceProgram?.edeboId ?? '',
    sourceProgram?.specialtyCodeRaw || specialtyCodes(sourceProgram),
    sourceProgram?.specialtyNameRaw || specialtyNames(sourceProgram),
    sourceProgram?.nameUk || '',
    sourceProgram?.educationLevelRaw || levelLabel(sourceProgram?.educationLevelId),
    sourceProgram?.degreeRaw || degreeLabel(sourceProgram?.educationLevelId),
    sourceProgram?.studyForm || '',
    sourceProgram?.volumeAndDuration || '',
    sourceProgram?.unitNameRaw || unitLabel(sourceProgram?.unitId, ''),
    approvalOrders.join('; '),
    '',
    '',
    qNames.join('; '),
    mandatory.join('; '),
    nak.join('; '),
    targetProgram ? (targetProgram.specialtyCodeRaw || targetSpecs.map(x => x.code).join(' ')) : '',
    targetProgram ? (targetProgram.specialtyNameRaw || targetSpecs.map(x => x.nameUk).join('; ')) : '',
    targetProgram?.edeboId ?? '',
    targetProgram?.nameUk || '',
    extensionOrders.join('; ')
  ];
}

function qualificationName(id, fallback='') {
  const q = state.qualifications.get(id);
  if (!q) return fallback || id || '';
  return q.nameEn ? `${q.nameUk} / ${q.nameEn}` : q.nameUk;
}
function formatOrder(order) {
  if (!order) return '';
  if (order.raw) return order.raw;
  if (order.number && order.date) {
    const d = String(order.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return d ? `${order.number} від ${d[3]}.${d[2]}.${d[1]}` : `${order.number} від ${order.date}`;
  }
  return order.number || '';
}
function degreeLabel(levelId) {
  return ({ bachelor: 'Бакалавр', master: 'Магістр', phd: 'Доктор філософії' })[levelId] || '';
}
function specialtyCodes(program) {
  return (program?.specialtyIds || []).map(id => state.specialties.get(id)?.code).filter(Boolean).join(' ');
}
function specialtyNames(program) {
  return (program?.specialtyIds || []).map(id => state.specialties.get(id)?.nameUk).filter(Boolean).join('; ');
}
function unique(values) { return [...new Set(values.map(v => String(v ?? '').trim()).filter(Boolean))]; }

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, runner));
  return results;
}

function option(value, label, selected) {
  return `<option value="${escapeAttr(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}
function normalizeName(s) { return String(s||'').trim().replace(/\s+/g,' ').toLocaleLowerCase('uk-UA'); }
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

let busyCount = 0;
function setBusy(on, text='Збереження…') {
  busyCount += on ? 1 : -1; busyCount = Math.max(0,busyCount);
  document.body.classList.toggle('busy', busyCount > 0);
  $('dataStatus').textContent = busyCount > 0 ? text : `Дані завантажено: ${state.index.length} ОП`;
}
function showToast(message, type='info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

init();
