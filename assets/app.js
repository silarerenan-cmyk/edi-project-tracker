/* BRE Initiative Tracker — single-file app logic. */

const SECTIONS = ['overview', 'epics', 'updates', 'next-steps'];
const STORAGE_PREFIX = 'bre-tracker:';
const DISK_PREFIX    = STORAGE_PREFIX + 'disk:';
const OVERLAY_PREFIX = STORAGE_PREFIX + 'overlay:';

// Schema version — bump when data shape changes so cached `disk:*` snapshots are invalidated.
// Overlays (manual additions / edits / deletions) are NEVER cleared by a version bump.
const SCHEMA_VERSION = 11;

// Sections whose `updates`/`tasks` arrays support manual overlays (add/edit/delete that survives a refresh).
const OVERLAYABLE = {
  'updates':    { listKey: 'updates', idKey: 'id' },
  'next-steps': { listKey: 'tasks',   idKey: 'id' },
};

const COUNTRY_FLAGS = {
  MX: { name: 'Mexico',    svg: '<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="1" height="2" fill="#006847"/><rect x="1" width="1" height="2" fill="#fff"/><rect x="2" width="1" height="2" fill="#ce1126"/></svg>' },
  AR: { name: 'Argentina', svg: '<svg viewBox="0 0 9 6" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="9" height="2" fill="#75AADB"/><rect y="2" width="9" height="2" fill="#fff"/><rect y="4" width="9" height="2" fill="#75AADB"/><circle cx="4.5" cy="3" r="0.7" fill="#F6B40E"/></svg>' },
  BR: { name: 'Brazil',    svg: '<svg viewBox="0 0 14 10" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="14" height="10" fill="#009c3b"/><polygon points="7,1.5 12.5,5 7,8.5 1.5,5" fill="#ffdf00"/><circle cx="7" cy="5" r="2" fill="#002776"/></svg>' },
};

const state = {
  overview: null,
  epics: null,
  updates: null,
  'next-steps': null,
};

const ui = {
  scopeCountry: 'all',
  scopeGroup: 'all',
  roadmapTrack: 'all',
};

/* ------------------------- Persistence (overlay model) -------------------------
 *
 * Each section has up to two layers in localStorage:
 *   `disk:<section>`    — the most recent snapshot of data/<section>.json (cleared on schema bump)
 *   `overlay:<section>` — manual changes the user made:
 *                         { added: [...], edited: { [id]: patch }, deleted: [id, ...] }
 *
 * `state[section]` is the merged view the renderer sees. Overlays SURVIVE schema bumps
 * and disk re-fetches, so manual additions and edits are never wiped by a refresh.
 */

function loadOverlay(section) {
  if (!OVERLAYABLE[section]) return null;
  try {
    const raw = localStorage.getItem(OVERLAY_PREFIX + section);
    if (!raw) return { added: [], edited: {}, deleted: [] };
    const o = JSON.parse(raw);
    return {
      added:   Array.isArray(o.added)   ? o.added   : [],
      edited:  o.edited && typeof o.edited === 'object' ? o.edited : {},
      deleted: Array.isArray(o.deleted) ? o.deleted : [],
    };
  } catch {
    return { added: [], edited: {}, deleted: [] };
  }
}

function saveOverlay(section, overlay) {
  if (!OVERLAYABLE[section]) return;
  localStorage.setItem(OVERLAY_PREFIX + section, JSON.stringify(overlay));
}

function applyOverlay(section, diskData, overlay) {
  if (!OVERLAYABLE[section] || !overlay) return diskData;
  const { listKey, idKey } = OVERLAYABLE[section];
  const list = Array.isArray(diskData?.[listKey]) ? diskData[listKey] : [];
  const editedMap = overlay.edited || {};
  const deletedSet = new Set(overlay.deleted || []);

  const merged = list
    .filter(item => !deletedSet.has(item[idKey]))
    .map(item => editedMap[item[idKey]] ? { ...item, ...editedMap[item[idKey]] } : item)
    .concat(overlay.added || []);

  return { ...diskData, [listKey]: merged };
}

async function fetchDiskJSON(section) {
  const res = await fetch(`data/${section}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load data/${section}.json`);
  return await res.json();
}

async function loadSection(section) {
  const ver = Number(localStorage.getItem(STORAGE_PREFIX + 'schemaVersion') || 0);
  if (ver !== SCHEMA_VERSION) {
    // Drop disk snapshots; KEEP overlays so manual edits survive.
    SECTIONS.forEach(s => localStorage.removeItem(DISK_PREFIX + s));
    // Also clear any legacy keys from the pre-overlay version.
    SECTIONS.forEach(s => localStorage.removeItem(STORAGE_PREFIX + s));
    localStorage.setItem(STORAGE_PREFIX + 'schemaVersion', String(SCHEMA_VERSION));
  }

  let diskData;
  const cached = localStorage.getItem(DISK_PREFIX + section);
  if (cached) {
    try { diskData = JSON.parse(cached); } catch { diskData = null; }
  }
  if (!diskData) {
    diskData = await fetchDiskJSON(section);
    localStorage.setItem(DISK_PREFIX + section, JSON.stringify(diskData));
  }

  const overlay = loadOverlay(section);
  return applyOverlay(section, diskData, overlay);
}

// Compute and persist the overlay diff between current state[section] and the disk snapshot.
function saveSection(section) {
  if (!OVERLAYABLE[section]) {
    // Non-overlayable sections (overview, epics) — just snapshot back to disk cache.
    localStorage.setItem(DISK_PREFIX + section, JSON.stringify(state[section]));
    return;
  }
  const { listKey, idKey } = OVERLAYABLE[section];
  let diskData;
  try {
    diskData = JSON.parse(localStorage.getItem(DISK_PREFIX + section));
  } catch { diskData = null; }
  if (!diskData) return; // shouldn't happen; loadSection always seeds it

  const diskList = Array.isArray(diskData[listKey]) ? diskData[listKey] : [];
  const diskById = new Map(diskList.map(it => [it[idKey], it]));
  const currentList = state[section]?.[listKey] || [];
  const currentIds = new Set(currentList.map(it => it[idKey]));

  const overlay = { added: [], edited: {}, deleted: [] };

  for (const it of currentList) {
    const id = it[idKey];
    const original = diskById.get(id);
    if (!original) {
      overlay.added.push(it);
    } else {
      const patch = computePatch(original, it);
      if (patch) overlay.edited[id] = patch;
    }
  }
  for (const id of diskById.keys()) {
    if (!currentIds.has(id)) overlay.deleted.push(id);
  }
  saveOverlay(section, overlay);
}

// Returns a minimal patch (object of changed fields) or null if no changes.
function computePatch(original, current) {
  const patch = {};
  let changed = false;
  const keys = new Set([...Object.keys(original || {}), ...Object.keys(current || {})]);
  for (const k of keys) {
    if (JSON.stringify(original?.[k]) !== JSON.stringify(current?.[k])) {
      patch[k] = current?.[k];
      changed = true;
    }
  }
  return changed ? patch : null;
}

// Re-fetch a single section's JSON file from disk; manual overlays are preserved.
async function reloadSectionFromDisk(section) {
  try {
    const diskData = await fetchDiskJSON(section);
    localStorage.setItem(DISK_PREFIX + section, JSON.stringify(diskData));
    const overlay = loadOverlay(section);
    state[section] = applyOverlay(section, diskData, overlay);
    renderAll();
  } catch (err) {
    console.error(err);
    alert(`Could not reload ${section} from disk: ${err.message}`);
  }
}

// Wipe just the manual overlay for a given section (revert to pristine disk).
function clearOverlay(section) {
  if (!OVERLAYABLE[section]) return;
  if (!confirm(`Discard all manual additions, edits, and deletions for ${section}? This cannot be undone.`)) return;
  localStorage.removeItem(OVERLAY_PREFIX + section);
  reloadSectionFromDisk(section);
}

function resetAll() {
  if (!confirm('Reset everything: drop all manual edits and re-load from the JSON files on disk. This cannot be undone.')) return;
  SECTIONS.forEach(s => {
    localStorage.removeItem(STORAGE_PREFIX + s);
    localStorage.removeItem(DISK_PREFIX + s);
    localStorage.removeItem(OVERLAY_PREFIX + s);
  });
  localStorage.removeItem(STORAGE_PREFIX + 'schemaVersion');
  location.reload();
}

/* ------------------------- Utilities ------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmtDate = (iso) => {
  if (!iso) return '';
  // Parse YYYY-MM-DD as a local date so it doesn't shift due to UTC.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const todayISO = () => new Date().toISOString().slice(0, 10);

const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function downloadJSON(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFileAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsText(file);
  });
}

/* ------------------------- Modal helper ------------------------- */

function openModal(title, fields, { saveLabel = 'Save' } = {}) {
  const dlg = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalSave').textContent = saveLabel;
  const body = $('#modalBody');
  body.innerHTML = '';

  for (const f of fields) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `f_${f.name}`;
    wrap.appendChild(label);

    let input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
    } else if (f.type === 'select') {
      input = document.createElement('select');
      for (const opt of f.options) {
        const o = document.createElement('option');
        o.value = typeof opt === 'string' ? opt : opt.value;
        o.textContent = typeof opt === 'string' ? opt : opt.label;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      input.type = f.type || 'text';
    }
    input.id = `f_${f.name}`;
    input.name = f.name;
    if (f.value != null) input.value = f.value;
    if (f.required) input.required = true;
    if (f.placeholder) input.placeholder = f.placeholder;
    wrap.appendChild(input);
    body.appendChild(wrap);
  }

  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      if (dlg.returnValue !== 'save') return resolve(null);
      const result = {};
      for (const f of fields) result[f.name] = $(`#f_${f.name}`).value;
      resolve(result);
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

/* ------------------------- Overview ------------------------- */

function renderOverviewSummary() {
  const o = state.overview || {};
  $('#brandTitle').textContent = o.name || 'Initiative';
  $('#brandSub').textContent = `${o.status ?? '—'} · Owner: ${o.owner ?? '—'}`;
  $('#overviewSummary').innerHTML = `<p class="overview-tagline">${escapeHtml(o.tagline || '')}</p>`;
}

function renderFlow(flow, highlightIdx) {
  if (!flow || !flow.length) return '';
  const parts = [];
  flow.forEach((step, i) => {
    if (i > 0) parts.push('<span class="arrow">→</span>');
    const cls = i === highlightIdx ? 'step highlight' : 'step';
    parts.push(`<div class="${cls}">${escapeHtml(step)}</div>`);
  });
  return `<div class="flow">${parts.join('')}</div>`;
}

function renderCurrentState() {
  const cs = state.overview?.currentState;
  const root = $('#currentStateView');
  if (!cs) { root.innerHTML = '<p style="color:var(--text-muted)">No current-state info.</p>'; return; }
  const today = cs.today || {};
  const target = cs.target || {};
  const targetHighlight = (target.flow || []).findIndex(s => /BEES/i.test(s));

  root.innerHTML = `
    <div class="state-grid">
      <div class="state-box today">
        <h4>Today</h4>
        <p>${escapeHtml(today.description || '')}</p>
        ${renderFlow(today.flow)}
        ${today.pains?.length ? `<ul class="bullets pains">${today.pains.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="state-box target">
        <h4>Target state</h4>
        <p>${escapeHtml(target.description || '')}</p>
        ${renderFlow(target.flow, targetHighlight)}
        ${target.gains?.length ? `<ul class="bullets gains">${target.gains.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>
  `;
}

function flagHtml(code) {
  const f = COUNTRY_FLAGS[code];
  if (!f) return `<span class="flag">${escapeHtml(code)}</span>`;
  return `<span class="flag" title="${f.name}">${f.svg}<span>${escapeHtml(code)}</span></span>`;
}

function isPostponed(rule) {
  return (rule.tags || []).includes('postponed');
}

function renderScope() {
  const rules = state.overview?.scope?.businessRules || [];
  const root = $('#scopeView');

  const sorted = rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const pa = isPostponed(a.r) ? 1 : 0;
      const pb = isPostponed(b.r) ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return a.i - b.i;
    })
    .map(x => x.r);

  const filtered = sorted.filter(r => {
    if (ui.scopeCountry !== 'all' && !(r.countries || []).includes(ui.scopeCountry)) return false;
    if (ui.scopeGroup !== 'all' && r.group !== ui.scopeGroup) return false;
    return true;
  });

  $('#scopeCount').textContent = `${filtered.length} of ${rules.length} rules`;

  if (!filtered.length) {
    root.innerHTML = '<p style="color:var(--text-muted)">No rules match the current filters.</p>';
    return;
  }

  const firstPostponed = filtered.findIndex(isPostponed);
  const cards = filtered.map((r, idx) => {
    const sep = (firstPostponed >= 0 && idx === firstPostponed)
      ? '<div class="scope-divider">Postponed</div>'
      : '';
    return sep + `
      <div class="rule-card ${isPostponed(r) ? 'is-postponed' : ''}">
        <div class="rc-head">
          <span class="rc-id">${escapeHtml(r.id)}</span>
          <span class="rc-group">${escapeHtml(r.group || '')}</span>
          ${(r.tags || []).map(t => `<span class="tag ${t === 'new' ? 'new' : t === 'postponed' ? 'postponed' : ''}">${escapeHtml(t)}</span>`).join('')}
          <span class="rc-flags" style="margin-left:auto;">
            ${(r.countries || []).map(flagHtml).join('')}
          </span>
        </div>
        <div class="rc-title">${escapeHtml(r.title)}</div>
        <div class="rc-desc">${escapeHtml(r.description || '')}</div>
        ${r.impact ? `<div class="rc-impact">${escapeHtml(r.impact)}</div>` : ''}
      </div>
    `;
  });

  root.innerHTML = cards.join('');
}

function renderOverview() {
  renderOverviewSummary();
  renderCurrentState();
  renderScope();
}

/* ------------------------- Epics — helpers ------------------------- */

function phaseFromStatus(status) {
  return state.epics?.phaseFromStatus?.[status] || 'discovery';
}

function activeEpics() {
  return (state.epics?.epics || []).filter(e => phaseFromStatus(e.status) !== 'excluded');
}

function activeInitiatives() {
  return (state.epics?.initiatives || []).filter(i => phaseFromStatus(i.status) !== 'excluded');
}

function epicsByPhase(phase) {
  return activeEpics().filter(e => phaseFromStatus(e.status) === phase);
}

function epicsForInitiative(ipKey, phase) {
  return activeEpics().filter(e => e.parentKey === ipKey && (!phase || phaseFromStatus(e.status) === phase));
}

function initiativeByKey(key) {
  return (state.epics?.initiatives || []).find(i => i.key === key);
}

function epicByKey(key) {
  return (state.epics?.epics || []).find(e => e.key === key);
}

function epicOrInitiativeByKey(key) {
  return epicByKey(key) || initiativeByKey(key);
}

function knownEpicKeys() {
  const eks = (state.epics?.epics || []).map(e => e.key);
  const iks = (state.epics?.initiatives || []).map(i => i.key);
  return new Set([...eks, ...iks]);
}

/* ------------------------- Epic ↔ updates/tasks linking ------------------------- */

const EPIC_KEY_RE = /\bBEES[A-Z]+-\d{2,6}\b/g;

function inferEpicKeysFromText(...strings) {
  const known = knownEpicKeys();
  const found = new Set();
  for (const s of strings) {
    if (!s) continue;
    const text = Array.isArray(s) ? s.join('\n') : String(s);
    const matches = text.match(EPIC_KEY_RE) || [];
    for (const m of matches) if (known.has(m)) found.add(m);
  }
  return [...found];
}

function epicKeysForUpdate(u) {
  const known = knownEpicKeys();
  const explicit = (u.epicKeys || []).filter(k => known.has(k));
  const inferred = inferEpicKeysFromText(u.title, u.summary, u.decisions, u.actionItems);
  return [...new Set([...explicit, ...inferred])];
}

function epicKeysForTask(t) {
  const known = knownEpicKeys();
  const explicit = (t.epicKeys || []).filter(k => known.has(k));
  const inferred = inferEpicKeysFromText(t.task, t.owner);
  return [...new Set([...explicit, ...inferred])];
}

// Build a reverse index: { 'BEESEDI-XXXXX': { updates: [...], tasks: [...] } }
function buildEpicLinkIndex() {
  const idx = {};
  const ensure = (k) => (idx[k] || (idx[k] = { updates: [], tasks: [] }));
  for (const u of state.updates?.updates || []) {
    for (const k of epicKeysForUpdate(u)) ensure(k).updates.push(u);
  }
  for (const t of state['next-steps']?.tasks || []) {
    for (const k of epicKeysForTask(t)) ensure(k).tasks.push(t);
  }
  return idx;
}

let epicLinkIndex = {};
function refreshEpicLinkIndex() { epicLinkIndex = buildEpicLinkIndex(); }
function linksForEpic(key) { return epicLinkIndex[key] || { updates: [], tasks: [] }; }

/* ------------------------- Epic side panel ------------------------- */

let openEpicPanelKey = null;

function openEpicPanel(key) {
  const item = epicOrInitiativeByKey(key);
  if (!item) return;
  openEpicPanelKey = key;

  const isInitiative = !!initiativeByKey(key);
  const phase = phaseFromStatus(item.status);
  const phaseLabel = phase === 'discovery' ? 'Discovery' : phase === 'delivery' ? 'Delivery' : 'Excluded';

  const keyEl = $('#epicPanelKey');
  keyEl.textContent = key;
  keyEl.href = item.url || '#';

  const phaseEl = $('#epicPanelPhase');
  phaseEl.textContent = phaseLabel;
  phaseEl.className = `ep-phase phase-${phase}`;

  $('#epicPanelTitle').textContent = item.shortTitle || item.title || key;

  // Meta row
  const metaParts = [];
  if (isInitiative) {
    metaParts.push(`<span class="ep-meta-item"><strong>Initiative</strong></span>`);
  } else if (item.parentKey) {
    const parent = initiativeByKey(item.parentKey);
    const parentLabel = parent ? `${parent.key} · ${parent.shortTitle || parent.title || ''}` : item.parentKey;
    metaParts.push(`<span class="ep-meta-item">Parent: <strong>${escapeHtml(parentLabel)}</strong></span>`);
  }
  if (item.status) metaParts.push(`<span class="ep-meta-item">Status: <strong>${escapeHtml(item.status)}</strong></span>`);
  if (item.targetQuarter) metaParts.push(`<span class="ep-meta-item">Target: <strong>${escapeHtml(item.targetQuarter)}</strong></span>`);
  if (item.owner && item.owner !== 'Unassigned') metaParts.push(`<span class="ep-meta-item">Owner: <strong>${escapeHtml(item.owner)}</strong></span>`);

  let metaHtml = metaParts.join('');
  if (item.summary) {
    metaHtml += `<div class="ep-summary">${escapeHtml(item.summary)}</div>`;
  } else if (!isInitiative && item.title && item.title !== item.shortTitle) {
    metaHtml += `<div class="ep-summary">${escapeHtml(item.title)}</div>`;
  }
  $('#epicPanelMeta').innerHTML = metaHtml;

  // Updates
  const links = linksForEpic(key);
  const updatesEl = $('#epicPanelUpdates');
  if (!links.updates.length) {
    updatesEl.innerHTML = `<div class="ep-empty">No updates yet — they'll appear here once tagged with this epic.</div>`;
  } else {
    const sorted = links.updates.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    updatesEl.innerHTML = sorted.map(u => {
      const decisions = (u.decisions || []).filter(Boolean);
      const actions = (u.actionItems || []).filter(Boolean);
      const detailsBlocks = [];
      if (decisions.length) {
        detailsBlocks.push(`<div class="ep-update-section-label">Decisions</div><ul>${decisions.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`);
      }
      if (actions.length) {
        detailsBlocks.push(`<div class="ep-update-section-label">Action items</div><ul>${actions.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`);
      }
      const moreCount = decisions.length + actions.length;
      return `
        <div class="ep-update">
          <div class="ep-update-head">
            <span class="chip">${escapeHtml(u.audience || '—')}</span>
            <span class="ep-update-title">${escapeHtml(u.title || '(untitled)')}</span>
            <span class="ep-update-date">${escapeHtml(fmtDate(u.date))}</span>
          </div>
          <div class="ep-update-summary">${escapeHtml(u.summary || '')}</div>
          ${moreCount ? `<details><summary>Decisions &amp; action items (${moreCount})</summary>${detailsBlocks.join('')}</details>` : ''}
        </div>
      `;
    }).join('');
  }

  // Open tasks
  const tasksEl = $('#epicPanelTasks');
  if (!links.tasks.length) {
    tasksEl.innerHTML = `<div class="ep-empty">No next steps tagged for this epic yet.</div>`;
  } else {
    const sorted = links.tasks.slice().sort((a, b) => (a.due || '').localeCompare(b.due || ''));
    tasksEl.innerHTML = sorted.map(t => `
      <div class="ep-task">
        <div class="ep-task-text">${escapeHtml(t.task)}</div>
        <div class="ep-task-meta">
          <span class="chip ${STATUS_CHIP[t.status] || 'grey'}">${escapeHtml(STATUS_LABELS[t.status] || t.status || '—')}</span>
          ${t.owner ? `<span>${escapeHtml(t.owner)}</span>` : ''}
          ${t.due ? `<span class="${dueClass(t.due)}">Due ${escapeHtml(fmtDate(t.due))}</span>` : ''}
          <span class="ep-task-actions">
            <button class="btn btn-icon" data-act="edit-step" data-id="${escapeHtml(t.id)}">Edit</button>
          </span>
        </div>
      </div>
    `).join('');
  }

  $('#epicPanel').hidden = false;
  $('#epicPanelBackdrop').hidden = false;
  // force reflow then add class so transitions play
  requestAnimationFrame(() => {
    $('#epicPanel').classList.add('is-open');
    $('#epicPanelBackdrop').classList.add('is-open');
  });
}

function closeEpicPanel() {
  openEpicPanelKey = null;
  const panel = $('#epicPanel');
  const bd = $('#epicPanelBackdrop');
  panel.classList.remove('is-open');
  bd.classList.remove('is-open');
  setTimeout(() => {
    if (!panel.classList.contains('is-open')) {
      panel.hidden = true;
      bd.hidden = true;
    }
  }, 250);
}

/* ------------------------- Backlog (2 columns by phase, grouped by initiative) ------------------------- */

function countersHtml(key) {
  const links = linksForEpic(key);
  const u = links.updates.length;
  const t = links.tasks.length;
  if (!u && !t) return '';
  return `
    <span class="ec-counters" title="${u} updates · ${t} next steps">
      <span class="cnt ${u ? 'has' : ''}" aria-label="updates">📰 ${u}</span>
      <span class="cnt ${t ? 'has' : ''}" aria-label="next steps">✓ ${t}</span>
    </span>
  `;
}

function epicMiniCard(e) {
  const owner = e.owner && e.owner !== 'Unassigned' ? `<span class="ec-owner">${escapeHtml(e.owner)}</span>` : '';
  const tq = e.targetQuarter ? `<span class="tag">${escapeHtml(e.targetQuarter)}</span>` : '';
  const typeChip = e.type === 'Discovery' ? '<span class="tag tag-disc">Discovery</span>' : '';
  return `
    <div class="epic-card is-clickable" data-key="${escapeHtml(e.key)}">
      <div class="ec-head">
        <a class="ec-key" href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.key)}</a>
        ${typeChip}
        ${tq}
      </div>
      <div class="ec-title" title="${escapeHtml(e.title)}">${escapeHtml(e.shortTitle || e.title)}</div>
      <div class="ec-foot">
        <span class="ec-status">${escapeHtml(e.status)}</span>
        ${owner}
        ${countersHtml(e.key)}
      </div>
    </div>
  `;
}

function initiativeBlock(ip, phase) {
  const epics = epicsForInitiative(ip.key, phase);
  if (!epics.length) return '';
  return `
    <div class="ip-block">
      <div class="ip-head">
        <a class="ip-key" href="${escapeHtml(ip.url)}" target="_blank" rel="noopener">${escapeHtml(ip.key)}</a>
        <span class="ip-title" title="${escapeHtml(ip.title)}">${escapeHtml(ip.title)}</span>
        <span class="ip-count">${epics.length}</span>
      </div>
      <div class="ip-epics">
        ${epics.map(epicMiniCard).join('')}
      </div>
    </div>
  `;
}

function renderBacklog() {
  const initiatives = state.epics?.initiatives || [];

  // Discovery column
  let discBody = '';
  let discTotal = 0;
  for (const ip of initiatives) {
    const eps = epicsForInitiative(ip.key, 'discovery');
    discTotal += eps.length;
    if (eps.length) discBody += initiativeBlock(ip, 'discovery');
  }

  // Delivery column
  let delBody = '';
  let delTotal = 0;
  for (const ip of initiatives) {
    const eps = epicsForInitiative(ip.key, 'delivery');
    delTotal += eps.length;
    if (eps.length) delBody += initiativeBlock(ip, 'delivery');
  }

  $('#backlogDiscoveryCount').textContent = discTotal;
  $('#backlogDeliveryCount').textContent = delTotal;
  $('#backlogDiscoveryBody').innerHTML = discBody || '<div class="col-empty">No epics in Discovery.</div>';
  $('#backlogDeliveryBody').innerHTML = delBody || '<div class="col-empty">No epics in Delivery yet.</div>';
}

/* ------------------------- Roadmap (epics across quarters) ------------------------- */

function quarters() {
  const year = new Date().getFullYear();
  return [
    { id: 'Q1', label: `Q1 · Jan – Mar` },
    { id: 'Q2', label: `Q2 · Apr – Jun` },
    { id: 'Q3', label: `Q3 · Jul – Sep` },
    { id: 'Q4', label: `Q4 · Oct – Dec` },
  ];
}

function renderRoadmap() {
  $$('.roadmap-track-toggle .btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.track === ui.roadmapTrack);
  });

  const epics = activeEpics();
  const trackLabel = ui.roadmapTrack === 'all' ? 'All' : ui.roadmapTrack === 'discovery' ? 'Discovery' : 'Delivery';
  $('#roadmapMeta').textContent = `${epics.length} active epics · viewing: ${trackLabel}`;

  const grid = $('#roadmapGrid');
  grid.innerHTML = '';

  for (const q of quarters()) {
    const qEpics = epics.filter(e => e.targetQuarter === q.id && (
      ui.roadmapTrack === 'all' || phaseFromStatus(e.status) === ui.roadmapTrack
    ));

    const card = document.createElement('div');
    card.className = 'quarter';
    card.innerHTML = `
      <div class="quarter-head">
        <span class="q-id">${escapeHtml(q.id)}</span>
        <span class="q-label">${escapeHtml(q.label)}</span>
      </div>
      ${qEpics.length ? `
        <ul class="q-items">
          ${qEpics.map(e => {
            const ph = phaseFromStatus(e.status);
            return `
              <li class="q-item phase-${ph} is-clickable" data-key="${escapeHtml(e.key)}">
                <span class="q-dot dot dot-${ph === 'discovery' ? 'blue' : 'green'}"></span>
                <div class="q-item-body">
                  <div class="q-item-title" title="${escapeHtml(e.title)}">${escapeHtml(e.shortTitle || e.title)}</div>
                  <div class="q-item-meta">
                    <a class="q-link" href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.key)}</a>
                    <span class="q-status">${escapeHtml(e.status)}</span>
                    ${countersHtml(e.key)}
                  </div>
                </div>
              </li>
            `;
          }).join('')}
        </ul>
      ` : '<div class="q-empty">—</div>'}
    `;
    grid.appendChild(card);
  }
}

/* ------------------------- Progress (Discovery vs Delivery, epic counts) ------------------------- */

function renderProgress() {
  const epics = activeEpics();
  const total = epics.length;

  const inDiscovery = epicsByPhase('discovery').length;
  const inDelivery = epicsByPhase('delivery').length;

  const discPct = total ? Math.round((inDelivery / total) * 100) : 0; // moved past discovery
  const delPct  = total ? Math.round((inDelivery / total) * 100) : 0; // currently in delivery

  // Discovery progress = epics that have left Discovery (i.e. now in Delivery) / total
  // Delivery progress = same number from a delivery POV (live epics would be a subset)
  // To differentiate, we count "live" too.
  const live = epics.filter(e => ['In Production', 'Activated'].includes(e.status)).length;
  const realDelPct = total ? Math.round((live / total) * 100) : 0;

  $('#discoveryPercent').textContent = `${discPct}%`;
  $('#deliveryPercent').textContent  = `${realDelPct}%`;
  setRing('discoveryRing', discPct);
  setRing('deliveryRing', realDelPct);

  $('#discoveryDetail').innerHTML = `
    <div class="p-row"><span class="p-label">Active epics</span><strong>${total}</strong></div>
    <div class="p-row"><span class="p-label">In Discovery</span><span class="chip">${inDiscovery}</span></div>
    <div class="p-row"><span class="p-label">Past Discovery</span><span class="chip green">${inDelivery}</span></div>
  `;
  $('#deliveryDetail').innerHTML = `
    <div class="p-row"><span class="p-label">Active epics</span><strong>${total}</strong></div>
    <div class="p-row"><span class="p-label">In Delivery</span><span class="chip">${inDelivery}</span></div>
    <div class="p-row"><span class="p-label">Live (Prod/Activated)</span><span class="chip green">${live}</span></div>
  `;
}

function setRing(svgId, percent) {
  const ring = document.querySelector(`#${svgId} .ring-value`);
  const C = 2 * Math.PI * 50;
  ring.style.strokeDashoffset = String(C * (1 - percent / 100));
  document.getElementById(svgId.replace('Ring', 'RingText')).textContent = `${percent}%`;
}

/* ------------------------- Updates ------------------------- */

function renderUpdates() {
  const filter = $('#updatesFilter').value;
  const list = $('#updatesList');
  list.innerHTML = '';
  const updates = (state.updates?.updates || [])
    .slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .filter(u => filter === 'all' || u.audience === filter);

  if (!updates.length) {
    list.innerHTML = `<li style="color:var(--text-muted)">No updates yet.</li>`;
    return;
  }

  for (const u of updates) {
    const li = document.createElement('li');
    li.className = 'update';
    const decisions = (u.decisions || []).map(d => `<li>${escapeHtml(d)}</li>`).join('');
    const actions = (u.actionItems || []).map(d => `<li>${escapeHtml(d)}</li>`).join('');
    const keys = epicKeysForUpdate(u);
    const chips = keys.length
      ? `<div class="linked-epics">${keys.map(k => `<span class="linked-epic-chip" data-key="${escapeHtml(k)}" title="Open epic panel">${escapeHtml(k)}</span>`).join('')}</div>`
      : '';
    li.innerHTML = `
      <div class="update-head">
        <span class="chip">${escapeHtml(u.audience || '—')}</span>
        <span class="update-title">${escapeHtml(u.title || '(untitled)')}</span>
        <span class="update-date">${fmtDate(u.date)}</span>
      </div>
      <div class="update-summary">${escapeHtml(u.summary || '')}</div>
      ${chips}
      ${decisions ? `<div class="update-section"><strong>Decisions</strong><ul>${decisions}</ul></div>` : ''}
      ${actions ? `<div class="update-section"><strong>Action items</strong><ul>${actions}</ul></div>` : ''}
      <div class="update-section update-actions">
        <button class="btn btn-icon" data-act="edit-update" data-id="${u.id}">Edit</button>
        <button class="btn btn-icon btn-danger" data-act="del-update" data-id="${u.id}">Delete</button>
      </div>
    `;
    list.appendChild(li);
  }
}

function parseEpicKeysInput(s) {
  if (!s) return [];
  const known = knownEpicKeys();
  const tokens = String(s).split(/[,\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
  const valid = [], unknown = [];
  for (const t of tokens) {
    if (known.has(t)) valid.push(t);
    else unknown.push(t);
  }
  if (unknown.length) {
    console.warn('Unknown epic keys ignored:', unknown.join(', '));
  }
  return [...new Set(valid)];
}

async function addUpdate(prefill = {}) {
  const result = await openModal('Add update', [
    { label: 'Title', name: 'title', value: prefill.title || '', required: true },
    { label: 'Date', name: 'date', value: prefill.date || todayISO(), type: 'date' },
    { label: 'Audience', name: 'audience', value: prefill.audience || 'Engineering', type: 'select', options: ['Engineering','Architecture','Commercial','Partners','Product','Other'] },
    { label: 'Summary', name: 'summary', value: prefill.summary || '', type: 'textarea' },
    { label: 'Decisions (one per line)', name: 'decisions', value: (prefill.decisions || []).join('\n'), type: 'textarea' },
    { label: 'Action items (one per line)', name: 'actionItems', value: (prefill.actionItems || []).join('\n'), type: 'textarea' },
    { label: 'Linked epics (comma-separated keys, e.g. BEESEDI-48927)', name: 'epicKeys', value: (prefill.epicKeys || []).join(', ') },
  ]);
  if (!result) return;
  state.updates.updates.unshift({
    id: uid('U'),
    title: result.title,
    date: result.date,
    audience: result.audience,
    summary: result.summary,
    decisions: result.decisions.split('\n').map(s => s.trim()).filter(Boolean),
    actionItems: result.actionItems.split('\n').map(s => s.trim()).filter(Boolean),
    epicKeys: parseEpicKeysInput(result.epicKeys),
  });
  saveSection('updates');
  renderAll();
}

async function editUpdate(id) {
  const u = state.updates.updates.find(x => x.id === id);
  if (!u) return;
  const result = await openModal('Edit update', [
    { label: 'Title', name: 'title', value: u.title, required: true },
    { label: 'Date', name: 'date', value: u.date, type: 'date' },
    { label: 'Audience', name: 'audience', value: u.audience, type: 'select', options: ['Engineering','Architecture','Commercial','Partners','Product','Other'] },
    { label: 'Summary', name: 'summary', value: u.summary, type: 'textarea' },
    { label: 'Decisions (one per line)', name: 'decisions', value: (u.decisions || []).join('\n'), type: 'textarea' },
    { label: 'Action items (one per line)', name: 'actionItems', value: (u.actionItems || []).join('\n'), type: 'textarea' },
    { label: 'Linked epics (comma-separated keys, e.g. BEESEDI-48927)', name: 'epicKeys', value: (u.epicKeys || []).join(', ') },
  ]);
  if (!result) return;
  Object.assign(u, {
    title: result.title, date: result.date, audience: result.audience, summary: result.summary,
    decisions: result.decisions.split('\n').map(s => s.trim()).filter(Boolean),
    actionItems: result.actionItems.split('\n').map(s => s.trim()).filter(Boolean),
    epicKeys: parseEpicKeysInput(result.epicKeys),
  });
  saveSection('updates');
  renderAll();
}

function deleteUpdate(id) {
  if (!confirm('Delete this update?')) return;
  state.updates.updates = state.updates.updates.filter(u => u.id !== id);
  saveSection('updates');
  renderAll();
}

function parseNotesToUpdate(filename, text) {
  const lines = text.split(/\r?\n/);
  const firstLine = lines.find(l => l.trim()) || filename.replace(/\.[^.]+$/, '');
  const decisions = [], actionItems = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (/^(- )?(decision|decided)\s*[:\-]/i.test(l)) decisions.push(l.replace(/^(- )?(decision|decided)\s*[:\-]\s*/i, ''));
    else if (/^(- )?(action(\s*item)?|todo)\s*[:\-]/i.test(l)) actionItems.push(l.replace(/^(- )?(action(\s*item)?|todo)\s*[:\-]\s*/i, ''));
  }
  return {
    title: firstLine.replace(/^#+\s*/, '').slice(0, 120),
    date: todayISO(), audience: 'Engineering',
    summary: text.trim().slice(0, 2000),
    decisions, actionItems,
  };
}

/* ------------------------- Next steps ------------------------- */

const STATUS_LABELS = { not_started: 'Not started', in_progress: 'In progress', complete: 'Complete' };
const STATUS_CHIP   = { not_started: 'grey', in_progress: 'blue', complete: 'green' };

function dueClass(due) {
  if (!due) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(due);
  const diff = (d - today) / (1000 * 60 * 60 * 24);
  if (diff < 0) return 'due-overdue';
  if (diff <= 3) return 'due-soon';
  return '';
}

function renderNextSteps() {
  const tbody = $('#nextStepsBody');
  tbody.innerHTML = '';
  const tasks = (state['next-steps']?.tasks || []).slice().sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  if (!tasks.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text-muted)">No tasks yet.</td></tr>`;
    return;
  }
  for (const t of tasks) {
    const tr = document.createElement('tr');
    const keys = epicKeysForTask(t);
    const chips = keys.length
      ? `<div class="linked-epics">${keys.map(k => `<span class="linked-epic-chip" data-key="${escapeHtml(k)}" title="Open epic panel">${escapeHtml(k)}</span>`).join('')}</div>`
      : '';
    tr.innerHTML = `
      <td>${escapeHtml(t.task)}${chips}</td>
      <td>${escapeHtml(t.owner || '—')}</td>
      <td class="${dueClass(t.due)}">${fmtDate(t.due) || '—'}</td>
      <td><span class="chip ${STATUS_CHIP[t.status] || 'grey'}">${STATUS_LABELS[t.status] || t.status || '—'}</span></td>
      <td style="text-align:right; white-space:nowrap;">
        <button class="btn btn-icon" data-act="edit-step" data-id="${t.id}">Edit</button>
        <button class="btn btn-icon btn-danger" data-act="del-step" data-id="${t.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

async function addNextStep() {
  const result = await openModal('Add task', [
    { label: 'Task', name: 'task', required: true },
    { label: 'Owner', name: 'owner' },
    { label: 'Due date', name: 'due', type: 'date' },
    { label: 'Status', name: 'status', type: 'select', options: [
      { value: 'not_started', label: 'Not started' },
      { value: 'in_progress', label: 'In progress' },
      { value: 'complete', label: 'Complete' },
    ]},
    { label: 'Linked epics (comma-separated keys, e.g. BEESEDI-48927)', name: 'epicKeys', value: '' },
  ]);
  if (!result || !result.task) return;
  state['next-steps'].tasks.push({
    id: uid('NS'),
    task: result.task,
    owner: result.owner,
    due: result.due,
    status: result.status,
    epicKeys: parseEpicKeysInput(result.epicKeys),
  });
  saveSection('next-steps');
  renderAll();
}

async function editNextStep(id) {
  const t = state['next-steps'].tasks.find(x => x.id === id);
  if (!t) return;
  const result = await openModal('Edit task', [
    { label: 'Task', name: 'task', value: t.task, required: true },
    { label: 'Owner', name: 'owner', value: t.owner },
    { label: 'Due date', name: 'due', value: t.due, type: 'date' },
    { label: 'Status', name: 'status', value: t.status, type: 'select', options: [
      { value: 'not_started', label: 'Not started' },
      { value: 'in_progress', label: 'In progress' },
      { value: 'complete', label: 'Complete' },
    ]},
    { label: 'Linked epics (comma-separated keys, e.g. BEESEDI-48927)', name: 'epicKeys', value: (t.epicKeys || []).join(', ') },
  ]);
  if (!result) return;
  Object.assign(t, {
    task: result.task,
    owner: result.owner,
    due: result.due,
    status: result.status,
    epicKeys: parseEpicKeysInput(result.epicKeys),
  });
  saveSection('next-steps');
  renderAll();
}

function deleteNextStep(id) {
  if (!confirm('Delete this task?')) return;
  state['next-steps'].tasks = state['next-steps'].tasks.filter(t => t.id !== id);
  saveSection('next-steps');
  renderAll();
}

/* ------------------------- Import / Export ------------------------- */

async function handleImport(section, file) {
  const text = await readFileAsText(file);
  if (section === 'updates' && /\.(md|txt)$/i.test(file.name)) {
    await addUpdate(parseNotesToUpdate(file.name, text));
    return;
  }
  let json;
  try { json = JSON.parse(text); } catch { alert(`Could not parse ${file.name} as JSON.`); return; }
  state[section] = json;
  saveSection(section);
  renderAll();
}

function handleExport(section) { downloadJSON(section, state[section]); }

/* ------------------------- Theme ------------------------- */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(STORAGE_PREFIX + 'theme', t);
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme || 'light';
  applyTheme(cur === 'light' ? 'dark' : 'light');
}

/* ------------------------- Wire up ------------------------- */

function renderAll() {
  refreshEpicLinkIndex();
  renderOverview();
  renderBacklog();
  renderRoadmap();
  renderProgress();
  renderUpdates();
  renderNextSteps();
  if (openEpicPanelKey) openEpicPanel(openEpicPanelKey);
}

function setupEvents() {
  $$('input[data-import]').forEach(input => {
    input.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await handleImport(e.target.dataset.import, file);
      e.target.value = '';
    });
  });
  $$('button[data-export]').forEach(btn => {
    btn.addEventListener('click', () => handleExport(btn.dataset.export));
  });
  $$('button[data-reload]').forEach(btn => {
    btn.addEventListener('click', () => reloadSectionFromDisk(btn.dataset.reload));
  });
  $$('button[data-clear-overlay]').forEach(btn => {
    btn.addEventListener('click', () => clearOverlay(btn.dataset.clearOverlay));
  });

  $('#scopeCountry').addEventListener('change', (e) => { ui.scopeCountry = e.target.value; renderScope(); });
  $('#scopeGroup').addEventListener('change', (e) => { ui.scopeGroup = e.target.value; renderScope(); });

  $$('.roadmap-track-toggle .btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      ui.roadmapTrack = btn.dataset.track;
      renderRoadmap();
    });
  });

  $('#addUpdateBtn').addEventListener('click', () => addUpdate());
  $('#updatesFilter').addEventListener('change', renderUpdates);
  $('#updates').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'edit-update') editUpdate(btn.dataset.id);
    if (btn.dataset.act === 'del-update') deleteUpdate(btn.dataset.id);
  });

  $('#addStepBtn').addEventListener('click', addNextStep);
  $('#next-steps').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'edit-step') editNextStep(btn.dataset.id);
    if (btn.dataset.act === 'del-step') deleteNextStep(btn.dataset.id);
  });

  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#resetBtn').addEventListener('click', resetAll);

  // Epic side-panel — open
  document.addEventListener('click', (e) => {
    // ignore clicks that started inside a link, button, or summary (let them do their job)
    if (e.target.closest('a, button, summary')) return;
    const card = e.target.closest('.epic-card[data-key], .q-item[data-key]');
    if (card) {
      const key = card.dataset.key;
      if (key) openEpicPanel(key);
      return;
    }
    const chip = e.target.closest('.linked-epic-chip[data-key]');
    if (chip) {
      e.preventDefault();
      const key = chip.dataset.key;
      if (key) openEpicPanel(key);
    }
  });

  // Epic side-panel — close (backdrop, X, Esc)
  $('#epicPanelBackdrop').addEventListener('click', closeEpicPanel);
  $('#epicPanelClose').addEventListener('click', closeEpicPanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openEpicPanelKey) closeEpicPanel();
  });

  // Edit-step button inside the side panel
  $('#epicPanelTasks').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="edit-step"]');
    if (!btn) return;
    e.stopPropagation();
    editNextStep(btn.dataset.id);
  });
}

async function init() {
  applyTheme(localStorage.getItem(STORAGE_PREFIX + 'theme') || 'light');
  try {
    const results = await Promise.all(SECTIONS.map(loadSection));
    SECTIONS.forEach((s, i) => state[s] = results[i]);
  } catch (err) {
    console.error(err);
    alert('Could not load data files. If you opened the file directly, try serving the folder with a local server (see README).');
    return;
  }
  setupEvents();
  renderAll();
}

init();
