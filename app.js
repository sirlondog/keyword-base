'use strict';

const MAX_WORDS = 7;
const PAGE_SIZE = 300;
const LS_CFG = 'kb.cfg';
const LS_DB = 'kb.db';
const DEFAULT_CFG = { token: '', owner: 'sirlondog', repo: 'keyword-clusters', branch: 'main', path: 'data/keywords.json' };

let cfg = { ...DEFAULT_CFG, ...readLS(LS_CFG) };
let db = emptyDb();
let sha = null;          // sha файла на GitHub, от которого отталкивается локальная версия
let dirty = false;
let editVersion = 0;
let pendingMsgs = [];
let saving = false;
let saveTimer = null;
let saveError = '';
let lastSavedAt = null;

let view = { type: 'all' };
let sort = { key: 'f', dir: -1 };
let page = 0;
let rows = [];
let selected = new Set();
let lastClicked = -1;
let index = new Map();   // нормализованный ключ -> фраза глобальной базы

const $ = (id) => document.getElementById(id);

// ---------- утилиты ----------

function emptyDb() {
  return { version: 1, clusters: [], lists: [], keywords: [] };
}

function readLS(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function phrasesWord(n) {
  return `${n} ${plural(n, 'фраза', 'фразы', 'фраз')}`;
}

// Нормализация: регистр, ё→е, операторы Директа (! + " [ ] ( )), минус-слова не считаются.
// Ключ — отсортированные слова, поэтому «пк сборка» и «сборка пк» считаются дублями.
function norm(s) {
  const clean = String(s ?? '').replace(/\s+/g, ' ').trim();
  const words = clean.toLowerCase().replace(/ё/g, 'е').split(' ')
    .filter((t) => t && !t.startsWith('-'))
    .map((t) => t.replace(/[!+"\[\]()]/g, ''))
    .filter(Boolean);
  return { clean, key: words.slice().sort().join(' '), words: words.length };
}

const wordsCache = new Map();
function wordCount(p) {
  let n = wordsCache.get(p);
  if (n === undefined) { n = norm(p).words; wordsCache.set(p, n); }
  return n;
}

function rebuildIndex() {
  index = new Map(db.keywords.map((k) => [norm(k.p).key, k]));
}

function clusterName(id) {
  const c = id && db.clusters.find((x) => x.id === id);
  return c ? c.name : '';
}

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), isErr ? 6000 : 2500);
}

function openDialog(dlg) {
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true });
    dlg.showModal();
  });
}

// ---------- GitHub ----------

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function gh(method, path, body) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: 'Bearer ' + cfg.token,
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* пустой ответ */ }
    const hint = {
      401: 'токен не подходит — вставьте сам токен (начинается с github_pat_), он показывается один раз сразу после создания; токен также мог истечь',
      403: 'у токена нет права Contents: Read and write',
      404: method === 'GET' && path.includes('/contents/')
        ? ''
        : 'токен не видит репозиторий (GitHub отвечает Not Found) — добавьте его в Repository access токена и дайте Contents: Read and write',
    }[res.status];
    const err = new Error(hint ? `${hint} (${msg})` : msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function repoPath() {
  return `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
}

function filePath(path) {
  return `${repoPath()}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function contentsPath() {
  return filePath(cfg.path);
}

// Читает JSON-файл из репозитория: { data, sha }
async function readJsonFile(path) {
  const meta = await gh('GET', `${filePath(path)}?ref=${encodeURIComponent(cfg.branch)}`);
  // Файлы больше 1 МБ API отдаёт без содержимого — тогда читаем blob
  const b64 = meta.encoding === 'base64' && meta.content
    ? meta.content
    : (await gh('GET', `${repoPath()}/git/blobs/${meta.sha}`)).content;
  return { data: JSON.parse(b64decode(b64)), sha: meta.sha };
}

async function fetchRemote() {
  try {
    const file = await readJsonFile(cfg.path);
    return { data: normalizeDb(file.data), sha: file.sha };
  } catch (e) {
    if (e.status !== 404) throw e;
    // Без доступа к репозиторию GitHub тоже отвечает 404 — отличаем это от отсутствующего файла
    try {
      await gh('GET', repoPath());
    } catch (e2) {
      if (e2.status === 404) {
        const err = new Error(`токен не видит репозиторий ${cfg.owner}/${cfg.repo} (GitHub отвечает Not Found) — откройте токен на GitHub → Repository access → добавьте ${cfg.owner}/${cfg.repo}; право Contents: Read and write`);
        err.status = 404;
        throw err;
      }
      throw e2;
    }
    return { data: emptyDb(), sha: null, missing: true };
  }
}

function normalizeDb(d) {
  return {
    version: 1,
    clusters: Array.isArray(d.clusters) ? d.clusters : [],
    lists: (Array.isArray(d.lists) ? d.lists : []).map((l) => ({ ...l, items: Array.isArray(l.items) ? l.items : [] })),
    keywords: Array.isArray(d.keywords) ? d.keywords : [],
  };
}

// Одна фраза на строку — чтобы история изменений в git читалась построчно
function serialize(d) {
  const j = (v) => JSON.stringify(v);
  const arr = (items, ind) => items.length
    ? '[\n' + items.map((x) => ' '.repeat(ind) + j(x)).join(',\n') + '\n' + ' '.repeat(ind - 2) + ']'
    : '[]';
  const lists = d.lists.length
    ? '[\n' + d.lists.map((l) => `    {"id":${j(l.id)},"name":${j(l.name)},"purpose":${j(l.purpose || '')},"items":${arr(l.items, 6)}}`).join(',\n') + '\n  ]'
    : '[]';
  return `{\n  "version":1,\n  "clusters":${arr(d.clusters, 4)},\n  "lists":${lists},\n  "keywords":${arr(d.keywords, 4)}\n}\n`;
}

async function loadRemote() {
  if (!cfg.token) { renderSaveState(); return; }
  setSaveState('Загрузка с GitHub…');
  let remote;
  try {
    remote = await fetchRemote();
    transientState = '';
  } catch (e) {
    transientState = '';
    saveError = 'не удалось загрузить: ' + e.message;
    renderSaveState();
    toast('GitHub: ' + e.message, true);
    return;
  }
  if (dirty && sha !== remote.sha && !remote.missing) {
    const keepLocal = confirm(
      'В этом браузере есть несохранённые изменения, а файл на GitHub уже изменился с другого устройства.\n\n' +
      'OK — оставить версию из этого браузера и записать её на GitHub.\n' +
      'Отмена — взять версию с GitHub (локальные изменения пропадут).');
    if (keepLocal) {
      sha = remote.sha;
      saveError = '';
      persistLocal();
      scheduleSave(0);
      return;
    }
  } else if (dirty) {
    sha = remote.sha;
    saveError = '';
    scheduleSave(0);
    return;
  }
  db = remote.data;
  sha = remote.sha;
  dirty = false;
  saveError = '';
  pendingMsgs = [];
  lastSavedAt = new Date();
  afterDataReplaced();
  if (remote.missing) toast('Файл базы на GitHub не найден — он будет создан при первом изменении');
}

function scheduleSave(delay = 2500) {
  clearTimeout(saveTimer);
  if (cfg.token) saveTimer = setTimeout(save, delay);
  renderSaveState();
}

async function save() {
  if (!cfg.token || !dirty) return;
  if (saving) { scheduleSave(); return; }
  saving = true;
  renderSaveState();
  const version = editVersion;
  const msgs = pendingMsgs.slice();
  const message = msgs.length ? [...new Set(msgs)].join('; ').slice(0, 200) : 'Обновление базы ключей';
  try {
    const res = await gh('PUT', contentsPath(), {
      message,
      content: b64encode(serialize(db)),
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    });
    sha = res.content.sha;
    pendingMsgs = pendingMsgs.slice(msgs.length);
    if (editVersion === version) dirty = false;
    saveError = '';
    lastSavedAt = new Date();
    persistLocal();
  } catch (e) {
    saving = false;
    if (e.status === 409 || (e.status === 422 && /sha/i.test(e.message))) {
      await loadRemote();
      return;
    }
    saveError = e.message;
    toast('Не удалось сохранить на GitHub: ' + e.message, true);
  }
  saving = false;
  renderSaveState();
  if (dirty && !saveError) scheduleSave();
}

// ---------- локальное хранение ----------

function persistLocal() {
  try {
    localStorage.setItem(LS_DB, JSON.stringify({ db, sha, dirty, pendingMsgs }));
  } catch { /* переполнение localStorage не критично — основная копия на GitHub */ }
}

function loadLocal() {
  const s = readLS(LS_DB);
  if (s.db) {
    db = normalizeDb(s.db);
    sha = s.sha || null;
    dirty = !!s.dirty;
    pendingMsgs = s.pendingMsgs || [];
  }
}

function changed(msg) {
  editVersion++;
  dirty = true;
  if (msg) pendingMsgs.push(msg);
  persistLocal();
  render();
  scheduleSave();
}

function afterDataReplaced() {
  rebuildIndex();
  if (view.type === 'cluster' && !db.clusters.some((c) => c.id === view.id)) view = { type: 'all' };
  if (view.type === 'list' && !db.lists.some((l) => l.id === view.id)) view = { type: 'all' };
  selected.clear();
  persistLocal();
  render();
}

// ---------- состояние сохранения ----------

let transientState = '';
function setSaveState(text) {
  transientState = text;
  renderSaveState();
}

function renderSaveState() {
  const el = $('saveState');
  let text, cls = '';
  if (!cfg.token) { text = 'Не подключено к GitHub — данные только в этом браузере'; cls = 'err'; }
  else if (saving) text = 'Сохранение…';
  else if (transientState) text = transientState;
  else if (saveError) { text = 'Ошибка: ' + saveError + ' (нажмите, чтобы повторить)'; cls = 'err'; }
  else if (dirty) { text = 'Есть несохранённые изменения'; cls = 'dirty'; }
  else if (lastSavedAt) text = 'Синхронизировано ✓ ' + lastSavedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  else text = '';
  el.textContent = text;
  el.className = 'save-state ' + cls;
  el.style.cursor = cfg.token && (dirty || saveError) ? 'pointer' : '';
}

// ---------- данные текущего вида ----------

function currentList() {
  return view.type === 'list' ? db.lists.find((l) => l.id === view.id) : null;
}

function sourceRows() {
  if (view.type === 'list') return currentList()?.items || [];
  if (view.type === 'cluster') return db.keywords.filter((k) => k.c === view.id);
  if (view.type === 'nocluster') {
    const ids = new Set(db.clusters.map((c) => c.id));
    return db.keywords.filter((k) => !k.c || !ids.has(k.c));
  }
  return db.keywords;
}

function computeRows() {
  const q = $('search').value.toLowerCase().replace(/ё/g, 'е').trim().split(/\s+/).filter(Boolean);
  const st = $('statusFilter').value;
  let list = sourceRows();
  if (st !== 'all') list = list.filter((k) => String(k.s ? 1 : 0) === st);
  if (q.length) {
    list = list.filter((k) => {
      const p = k.p.toLowerCase().replace(/ё/g, 'е');
      return q.every((w) => p.includes(w));
    });
  }
  const { key, dir } = sort;
  const val = {
    p: (k) => k.p.toLowerCase(),
    w: (k) => wordCount(k.p),
    f: (k) => k.f || 0,
    wb: (k) => k.w?.b ?? -1,
    wq: (k) => k.w?.q ?? -1,
    we: (k) => k.w?.e ?? -1,
    c: (k) => clusterName(k.c).toLowerCase(),
    s: (k) => (k.s ? 1 : 0),
    d: (k) => k.d || '',
  }[key];
  rows = list.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    const r = typeof x === 'number' ? x - y : x.localeCompare(y, 'ru');
    return r * dir || a.p.localeCompare(b.p, 'ru');
  });
}

function viewTitle() {
  if (view.type === 'all') return 'Все ключи';
  if (view.type === 'nocluster') return 'Без кластера';
  if (view.type === 'cluster') return clusterName(view.id);
  return currentList()?.name || '';
}

// ---------- отрисовка ----------

function render() {
  renderNav();
  renderView();
  renderSaveState();
  renderJob();
}

function navItem(attrs, name, items, active) {
  const total = items.length;
  const loaded = items.reduce((n, k) => n + (k.s ? 1 : 0), 0);
  return `<div class="nav-item${active ? ' active' : ''}" ${attrs}>
    <span class="name" title="${esc(name)}">${esc(name)}</span>
    <span class="cnt" title="загружено / всего"><b>${loaded}</b> / ${total}</span>
  </div>`;
}

function renderNav() {
  const byCluster = new Map(db.clusters.map((c) => [c.id, []]));
  const none = [];
  for (const k of db.keywords) (byCluster.get(k.c) || none).push(k);

  $('navBase').innerHTML =
    navItem('data-view="all"', 'Все ключи', db.keywords, view.type === 'all') +
    navItem('data-view="nocluster"', 'Без кластера', none, view.type === 'nocluster');

  $('navClusters').innerHTML = db.clusters.length
    ? db.clusters.map((c) => navItem(`data-view="cluster" data-id="${esc(c.id)}"`, c.name, byCluster.get(c.id),
      view.type === 'cluster' && view.id === c.id)).join('')
    : '<div class="nav-item" style="color:#9aa7b4;cursor:default">нет кластеров</div>';

  $('navLists').innerHTML = db.lists.length
    ? db.lists.map((l) => navItem(`data-view="list" data-id="${esc(l.id)}" title="${esc(l.purpose || '')}"`, l.name, l.items,
      view.type === 'list' && view.id === l.id)).join('')
    : '<div class="nav-item" style="color:#9aa7b4;cursor:default">нет списков</div>';
}

function renderView() {
  computeRows();
  const isList = view.type === 'list';
  const list = currentList();

  $('viewTitle').textContent = viewTitle();
  $('viewPurpose').textContent = isList ? (list?.purpose || '') : '';

  const acts = [];
  if (view.type === 'cluster') acts.push('<button data-act="rename">✎ Переименовать</button>', '<button data-act="remove" class="danger">Удалить кластер</button>');
  if (isList) acts.push('<button data-act="rename">✎ Изменить</button>', '<button data-act="remove" class="danger">Удалить список</button>');
  $('viewActions').innerHTML = acts.join('');

  const src = sourceRows();
  const loaded = src.reduce((n, k) => n + (k.s ? 1 : 0), 0);
  const pct = src.length ? Math.round((loaded / src.length) * 100) : 0;
  $('stats').innerHTML = `
    <span>Всего: <b>${src.length}</b></span>
    <span class="ok">Загружено: <b>${loaded}</b></span>
    <span>Не загружено: <b>${src.length - loaded}</b></span>
    <span title="${pct}% загружено"><div class="progress"><div style="width:${pct}%"></div></div></span>
    ${rows.length !== src.length ? `<span>По фильтру: <b>${rows.length}</b></span>` : ''}`;

  const showCluster = view.type === 'all';
  const cols = [
    ['p', 'Фраза'],
    ['w', 'Слов', 'num'],
    ['wb', 'WS', 'ws', 'Wordstat: базовая частотность'],
    ['wq', '"WS"', 'ws', 'Wordstat: фразовая частотность "в кавычках"'],
    ['we', '"!WS"', 'ws', 'Wordstat: точная частотность "!слово"'],
    ['f', 'Вхожд.', 'num', 'Вхождений в отчёте Директа (из первичного импорта)'],
  ];
  if (showCluster) cols.push(['c', 'Кластер']);
  cols.push(['s', 'Статус'], ['d', 'Добавлено']);

  const allSel = rows.length > 0 && rows.every((k) => selected.has(k));
  $('thead').innerHTML = `<th class="cb nosort"><input type="checkbox" id="selAll" ${allSel ? 'checked' : ''} title="Выделить всё по фильтру"></th>` +
    cols.map(([k, t, cls, title]) => `<th data-sort="${k}" class="${cls || ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(t)}${sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page >= pages) page = pages - 1;
  const start = page * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);

  $('tbody').innerHTML = slice.map((k, i) => {
    const sel = selected.has(k);
    const wsTitle = k.w ? ` title="${esc(regionName(k.w.r))}, собрано ${esc(k.w.d || '')}"` : '';
    const ws = (t) => `<td class="ws"${wsTitle}>${k.w?.[t] ?? ''}</td>`;
    return `<tr data-i="${start + i}"${sel ? ' class="sel"' : ''}>
      <td class="cb"><input type="checkbox" ${sel ? 'checked' : ''}></td>
      <td class="ph">${esc(k.p)}</td>
      <td class="num">${wordCount(k.p)}</td>
      ${ws('b')}${ws('q')}${ws('e')}
      <td class="num">${k.f || ''}</td>
      ${showCluster ? `<td class="cl">${esc(clusterName(k.c)) || '—'}</td>` : ''}
      <td class="st"><span class="badge ${k.s ? 'on' : 'off'}" data-toggle title="Нажмите, чтобы переключить">${k.s ? '✔ загружено' : 'не загружено'}</span></td>
      <td class="date">${esc(k.d || '')}</td>
    </tr>`;
  }).join('');

  const empty = $('empty');
  if (!rows.length) {
    empty.textContent = src.length ? 'Ничего не найдено по фильтру' : 'Здесь пока нет фраз — нажмите «Добавить ключи»';
    empty.classList.remove('hidden');
  } else empty.classList.add('hidden');

  $('pager').innerHTML = pages > 1
    ? `<button data-page="-1" ${page === 0 ? 'disabled' : ''}>←</button>
       <span>${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} из ${rows.length}</span>
       <button data-page="1" ${page >= pages - 1 ? 'disabled' : ''}>→</button>`
    : '';

  renderBulk();
}

function renderBulk() {
  const n = selected.size;
  $('bulk').classList.toggle('hidden', n === 0);
  if (!n) return;
  $('bulkCount').textContent = `Выбрано: ${phrasesWord(n)}`;
  const move = $('bulkMove');
  if (view.type === 'list') { move.classList.add('hidden'); return; }
  move.classList.remove('hidden');
  move.innerHTML = '<option value="">Переместить в кластер…</option><option value="-">— без кластера —</option>' +
    db.clusters.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('') +
    '<option value="+">＋ новый кластер…</option>';
}

// ---------- действия ----------

function parseLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(/\t|;/);
    const p = cols[0].trim().replace(/^"(.*)"$/, '$1');
    if (!p || /^(фраза|фразы|ключ|ключевая фраза|запрос|keyword|phrase)$/i.test(p)) continue;
    const f = cols.slice(1).map((c) => parseInt(c.replace(/\s/g, ''), 10)).find((n) => !isNaN(n));
    out.push({ p, f });
  }
  return out;
}

function addPhrases(items, target, loaded) {
  const rep = { added: [], dupBatch: [], dupExisting: [], long: [] };
  const list = target.type === 'list' ? db.lists.find((l) => l.id === target.id) : null;
  const idx = list ? new Map(list.items.map((i) => [norm(i.p).key, i])) : index;
  const batch = new Set();
  const d = today();
  for (const { p, f } of items) {
    const n = norm(p);
    if (!n.key) continue;
    if (n.words > MAX_WORDS) { rep.long.push(n.clean); continue; }
    if (batch.has(n.key)) { rep.dupBatch.push(n.clean); continue; }
    batch.add(n.key);
    const ex = idx.get(n.key);
    if (ex) { rep.dupExisting.push({ p: n.clean, ex }); continue; }
    const kw = { p: n.clean, s: loaded ? 1 : 0, d };
    if (f) kw.f = f;
    if (!list && target.id) kw.c = target.id;
    (list ? list.items : db.keywords).push(kw);
    idx.set(n.key, kw);
    rep.added.push(kw);
  }
  if (rep.added.length) {
    const where = list ? `список «${list.name}»` : (target.id ? `кластер «${clusterName(target.id)}»` : 'базу');
    changed(`Добавлено ${phrasesWord(rep.added.length)} в ${where}`);
  }
  return rep;
}

function reportHtml(rep, target) {
  const isList = target.type === 'list';
  const where = (k) => isList ? '' : ` <span>— ${esc(clusterName(k.c) || 'без кластера')}, ${k.s ? 'загружено' : 'не загружено'}</span>`;
  const block = (title, items, fmt) => items.length
    ? `<details><summary class="warn">${title}: ${items.length}</summary><ul>${items.slice(0, 500).map(fmt).join('')}</ul>${items.length > 500 ? '<div>…и ещё ' + (items.length - 500) + '</div>' : ''}</details>`
    : '';
  return `<div class="ok">Добавлено: ${rep.added.length}</div>` +
    block(isList ? 'Уже есть в списке' : 'Уже есть в базе (дубли)', rep.dupExisting, (x) => `<li>${esc(x.p)}${where(x.ex)}</li>`) +
    block('Повторы внутри вставки', rep.dupBatch, (p) => `<li>${esc(p)}</li>`) +
    block(`Больше ${MAX_WORDS} слов — отброшены`, rep.long, (p) => `<li>${esc(p)} <span>(${norm(p).words} сл.)</span></li>`);
}

async function editGroup(type, item) {
  if (editLocked()) return null;
  const dlg = $('dlgGroup');
  $('groupTitle').textContent = item
    ? (type === 'cluster' ? 'Переименовать кластер' : 'Изменить список')
    : (type === 'cluster' ? 'Новый кластер' : 'Новый список ключей');
  $('groupName').value = item?.name || '';
  $('groupPurpose').value = item?.purpose || '';
  $('groupPurposeWrap').classList.toggle('hidden', type !== 'list');
  if ((await openDialog(dlg)) !== 'ok') return null;
  const name = $('groupName').value.trim();
  if (!name) return null;
  const coll = type === 'cluster' ? db.clusters : db.lists;
  if (coll.some((x) => x !== item && x.name.toLowerCase() === name.toLowerCase())) {
    toast(`${type === 'cluster' ? 'Кластер' : 'Список'} «${name}» уже есть`, true);
    return null;
  }
  if (item) {
    item.name = name;
    if (type === 'list') item.purpose = $('groupPurpose').value.trim();
    changed(`Переименовано: «${name}»`);
    return item;
  }
  const created = type === 'cluster'
    ? { id: uid('c_'), name }
    : { id: uid('l_'), name, purpose: $('groupPurpose').value.trim(), items: [] };
  coll.push(created);
  changed(`${type === 'cluster' ? 'Новый кластер' : 'Новый список'} «${name}»`);
  return created;
}

function selectedArray() {
  return rows.filter((k) => selected.has(k));
}

function copyPhrases(items) {
  if (!items.length) return;
  navigator.clipboard.writeText(items.map((k) => k.p).join('\n'))
    .then(() => toast(`Скопировано: ${phrasesWord(items.length)}`))
    .catch(() => toast('Не удалось скопировать в буфер', true));
}

function downloadCsv(items) {
  if (!items.length) return;
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Фраза', 'Слов', 'WS базовая', 'WS "фразовая"', 'WS "!точная"', 'Регион WS', 'Вхождений', 'Кластер', 'Статус', 'Добавлено'].join(';')];
  for (const k of items) {
    lines.push([q(k.p), wordCount(k.p), k.w?.b ?? '', k.w?.q ?? '', k.w?.e ?? '', q(k.w ? regionName(k.w.r) : ''), k.f || '',
      q(view.type === 'list' ? '' : clusterName(k.c)), k.s ? 'загружено' : 'не загружено', k.d || ''].join(';'));
  }
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${viewTitle().replace(/[\\/:*?"<>|]/g, '_')}-${today()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function bulkAction(act) {
  const items = selectedArray();
  if (act === 'clear') { selected.clear(); renderView(); return; }
  if (!items.length) return;
  if (act === 'copy') return copyPhrases(items);
  if (act === 'csv') return downloadCsv(items);
  if (act === 'ws') return openWs(items);
  if (editLocked()) return;
  if (act === 'loaded' || act === 'unloaded') {
    const s = act === 'loaded' ? 1 : 0;
    items.forEach((k) => { k.s = s; });
    changed(`${phrasesWord(items.length)} → ${s ? 'загружено' : 'не загружено'}`);
    return;
  }
  if (act === 'delete') {
    if (!confirm(`Удалить ${phrasesWord(items.length)}?`)) return;
    const del = new Set(items);
    const list = currentList();
    if (list) list.items = list.items.filter((k) => !del.has(k));
    else { db.keywords = db.keywords.filter((k) => !del.has(k)); rebuildIndex(); }
    selected.clear();
    changed(`Удалено ${phrasesWord(items.length)}`);
  }
}

async function moveSelected(value) {
  const items = selectedArray();
  if (!items.length || !value) return;
  if (editLocked()) { renderBulk(); return; }
  let id = value;
  if (value === '+') {
    const c = await editGroup('cluster');
    if (!c) { renderBulk(); return; }
    id = c.id;
  }
  items.forEach((k) => { if (id === '-') delete k.c; else k.c = id; });
  selected.clear();
  changed(`${phrasesWord(items.length)} → ${id === '-' ? 'без кластера' : `кластер «${clusterName(id)}»`}`);
}

async function removeCurrentGroup() {
  if (editLocked()) return;
  if (view.type === 'cluster') {
    const c = db.clusters.find((x) => x.id === view.id);
    const n = db.keywords.filter((k) => k.c === c.id).length;
    if (!confirm(`Удалить кластер «${c.name}»?\n${phrasesWord(n)} останутся в базе без кластера.`)) return;
    db.keywords.forEach((k) => { if (k.c === c.id) delete k.c; });
    db.clusters = db.clusters.filter((x) => x !== c);
    view = { type: 'nocluster' };
    selected.clear();
    changed(`Удалён кластер «${c.name}»`);
  } else if (view.type === 'list') {
    const l = currentList();
    if (!confirm(`Удалить список «${l.name}» вместе с ${phrasesWord(l.items.length)} в нём?`)) return;
    db.lists = db.lists.filter((x) => x !== l);
    view = { type: 'all' };
    selected.clear();
    changed(`Удалён список «${l.name}»`);
  }
}

function fillAddTargets(preferred) {
  const sel = $('addTarget');
  sel.innerHTML =
    '<optgroup label="База"><option value="c:">— без кластера —</option>' +
    db.clusters.map((c) => `<option value="c:${esc(c.id)}">Кластер: ${esc(c.name)}</option>`).join('') +
    '<option value="new-cluster">＋ новый кластер…</option></optgroup>' +
    '<optgroup label="Отдельные списки">' +
    db.lists.map((l) => `<option value="l:${esc(l.id)}">Список: ${esc(l.name)}</option>`).join('') +
    '<option value="new-list">＋ новый список…</option></optgroup>';
  sel.value = preferred;
  if (!sel.value) sel.value = 'c:';
  sel.dataset.prev = sel.value;
}

function openAdd() {
  if (editLocked()) return;
  const pref = view.type === 'cluster' ? 'c:' + view.id : view.type === 'list' ? 'l:' + view.id : 'c:';
  fillAddTargets(pref);
  $('addReport').innerHTML = '';
  $('addLoaded').checked = false;
  $('dlgAdd').showModal();
  $('addText').focus();
}

function targetFromValue(v) {
  return v.startsWith('l:') ? { type: 'list', id: v.slice(2) } : { type: 'cluster', id: v.slice(2) };
}

// ---------- частотность Wordstat (XMLRiver через GitHub Actions) ----------

const LS_WS = 'kb.ws';
const WS_PRICE = 0.025;          // ₽ за запрос по базовому тарифу XMLRiver (25 ₽ за 1000)
const WS_SEC_PER_REQUEST = 0.4;  // ориентир для оценки времени при 5 потоках
const JOB_STALE_MS = 30 * 60 * 1000;
const WS_TYPES = { b: 'базовая', q: '"фразовая"', e: '"!точная"' };
const REGIONS = [
  ['', 'Все регионы'],
  ['225', 'Россия'],
  ['10174', 'Санкт-Петербург и Ленинградская область'],
  ['2', 'Санкт-Петербург'],
  ['1', 'Москва и Московская область'],
  ['213', 'Москва'],
];

let job = null;
let jobSha = null;
let jobTimer = null;
let wsItems = [];

function regionName(r) {
  const found = REGIONS.find(([id]) => id === String(r ?? ''));
  return found ? found[1] : `регион ${r}`;
}

function jobPath() {
  const i = cfg.path.lastIndexOf('/');
  return (i >= 0 ? cfg.path.slice(0, i + 1) : '') + 'wordstat-job.json';
}

async function fetchJob() {
  try {
    const file = await readJsonFile(jobPath());
    jobSha = file.sha;
    return file.data;
  } catch (e) {
    if (e.status === 404) { jobSha = null; return null; }
    throw e;
  }
}

async function putJob(j, message) {
  const res = await gh('PUT', filePath(jobPath()), {
    message,
    content: b64encode(JSON.stringify(j, null, 1) + '\n'),
    branch: cfg.branch,
    ...(jobSha ? { sha: jobSha } : {}),
  });
  jobSha = res.content.sha;
}

// Задание считается активным, пока GitHub Actions подаёт признаки жизни
function jobActive(j) {
  if (!j || !['queued', 'running', 'cancel'].includes(j.status)) return false;
  return Date.now() - Date.parse(j.heartbeat || j.created) < JOB_STALE_MS;
}

function editLocked() {
  if (!jobActive(job)) return false;
  toast('Идёт сбор частотности — менять базу можно будет после его окончания', true);
  return true;
}

function renderJob() {
  const bar = $('jobBar');
  if (!jobActive(job)) { bar.classList.add('hidden'); return; }
  const pct = job.total ? Math.round(((job.done || 0) / job.total) * 100) : 0;
  const state = job.status === 'queued' ? 'ожидает запуска GitHub Actions…'
    : job.status === 'cancel' ? 'останавливается…'
    : `${job.done || 0} из ${phrasesWord(job.total)}`;
  const types = (job.types || []).map((t) => WS_TYPES[t]).join(', ');
  bar.innerHTML = `<b>📊 Сбор частотности</b><span>${esc(state)}</span>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <span class="hint">${esc(types)} · ${esc(regionName(job.region))}</span>
    ${job.status !== 'cancel' ? '<button data-job="cancel">Остановить</button>' : ''}`;
  bar.classList.remove('hidden');
}

async function pollJob() {
  clearTimeout(jobTimer);
  if (!cfg.token) return;
  let cur;
  try {
    cur = await fetchJob();
  } catch {
    jobTimer = setTimeout(pollJob, 30000);
    return;
  }
  const prev = job;
  job = cur;
  const sameJob = prev && cur && prev.id === cur.id;
  if (jobActive(cur)) {
    // Подтягиваем промежуточные результаты, когда GitHub Actions записал очередную пачку
    if (sameJob && (cur.done || 0) > (prev.done || 0) && !dirty) await loadRemote();
    jobTimer = setTimeout(pollJob, 10000);
  } else if (sameJob && jobActive(prev)) {
    if (!dirty) await loadRemote();
    if (cur.status === 'done') {
      toast(`Частотность собрана: ${phrasesWord(cur.total)}` + (cur.failed ? `, не удалось получить: ${cur.failed}` : ''));
    } else if (cur.status === 'error') {
      toast('Сбор частотности остановлен: ' + (cur.error || 'ошибка'), true);
    } else if (cur.status === 'cancelled') {
      toast('Сбор частотности остановлен');
    } else {
      toast('GitHub Actions перестал отвечать — сбор прерван. Уже собранные данные сохранены.', true);
    }
  }
  renderJob();
}

function syncRegionSelect() {
  const v = $('wsRegion').value.trim();
  $('wsRegionSel').value = REGIONS.some(([id]) => id === v) ? v : 'custom';
}

function wsSettings() {
  return {
    types: ['b', 'q', 'e'].filter((t) => $('ws' + t.toUpperCase()).checked),
    region: $('wsRegion').value.replace(/\s/g, ''),
    skip: $('wsSkip').checked,
  };
}

function wsPhrases({ types, region, skip }) {
  const seen = new Set();
  const out = [];
  for (const k of wsItems) {
    if (skip && k.w && String(k.w.r ?? '') === region && types.every((t) => k.w[t] != null)) continue;
    const key = norm(k.p).key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(k.p);
  }
  return out;
}

function updateWsEstimate() {
  const s = wsSettings();
  const el = $('wsEstimate');
  if (!s.types.length) { el.innerHTML = '<span class="warn">Выберите хотя бы один вид частотности</span>'; return; }
  if (s.region && !/^\d+(,\d+)*$/.test(s.region)) { el.innerHTML = '<span class="warn">ID региона — число (или несколько через запятую)</span>'; return; }
  const n = wsPhrases(s).length;
  const skipped = wsItems.length - n;
  const req = n * s.types.length;
  const mins = Math.max(1, Math.round((req * WS_SEC_PER_REQUEST) / 60));
  el.innerHTML = n
    ? `К сбору: <b>${phrasesWord(n)}</b>${skipped ? ` (пропущено ${skipped})` : ''} · запросов: <b>${req}</b>
       · ≈ <b>${(req * WS_PRICE).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽</b> по тарифу 25 ₽ за 1000 · примерно ${mins} мин`
    : '<span class="warn">У всех выбранных фраз частотность уже собрана</span>';
}

async function openWs(items) {
  if (!cfg.token) return openSettings();
  if (jobActive(job)) { toast('Сбор частотности уже идёт', true); return; }
  if (!items.length) { toast('Нет фраз для сбора', true); return; }
  wsItems = items;
  const saved = readLS(LS_WS);
  $('wsRegionSel').innerHTML = REGIONS.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('') +
    '<option value="custom">Другой — укажите ID</option>';
  $('wsB').checked = saved.types ? saved.types.includes('b') : true;
  $('wsQ').checked = saved.types ? saved.types.includes('q') : true;
  $('wsE').checked = saved.types ? saved.types.includes('e') : false;
  $('wsRegion').value = saved.region ?? '10174';
  $('wsSkip').checked = saved.skip ?? true;
  syncRegionSelect();
  $('wsScope').textContent = selected.size
    ? `Выделенные фразы: ${phrasesWord(items.length)}.`
    : `Все фразы раздела «${viewTitle()}» с учётом фильтров: ${phrasesWord(items.length)}. Чтобы собрать только часть — выделите фразы галочками.`;
  updateWsEstimate();
  if ((await openDialog($('dlgWs'))) !== 'ok') return;
  const s = wsSettings();
  localStorage.setItem(LS_WS, JSON.stringify(s));
  if (!s.types.length || (s.region && !/^\d+(,\d+)*$/.test(s.region))) { toast('Проверьте настройки сбора', true); return; }
  await startWs(wsPhrases(s), s);
}

async function startWs(phrases, { types, region }) {
  if (!phrases.length) { toast('Нет фраз для сбора', true); return; }
  if (dirty) {
    clearTimeout(saveTimer);
    await save();
    if (dirty) { toast('Сначала должны сохраниться изменения в базе — попробуйте ещё раз', true); return; }
  }
  try {
    const cur = await fetchJob();
    if (jobActive(cur)) { job = cur; renderJob(); toast('Сбор частотности уже идёт', true); return; }
    const now = new Date().toISOString();
    const next = { id: uid('ws_'), status: 'queued', created: now, heartbeat: now, types, region, total: phrases.length, done: 0, phrases };
    await putJob(next, `Wordstat: задание на ${phrasesWord(phrases.length)}`);
    job = next;
    renderJob();
    toast('Сбор запущен — частотность будет появляться в таблице по мере сбора');
    clearTimeout(jobTimer);
    jobTimer = setTimeout(pollJob, 15000);
  } catch (e) {
    toast('Не удалось запустить сбор: ' + e.message, true);
  }
}

async function cancelJob() {
  if (!confirm('Остановить сбор частотности? Уже собранные данные сохранятся.')) return;
  try {
    const cur = await fetchJob();
    if (!jobActive(cur)) { job = cur; renderJob(); return; }
    // Задание, которое GitHub Actions ещё не взял, отменяем сразу
    const stopped = cur.status === 'queued'
      ? { ...cur, status: 'cancelled', finished: new Date().toISOString() }
      : { ...cur, status: 'cancel' };
    await putJob(stopped, 'Wordstat: отмена сбора');
    job = stopped;
    renderJob();
    clearTimeout(jobTimer);
    jobTimer = setTimeout(pollJob, 5000);
  } catch (e) {
    toast('Не удалось остановить: ' + e.message, true);
  }
}

// ---------- обработчики ----------

function bind() {
  document.querySelector('.side').addEventListener('click', (e) => {
    const it = e.target.closest('.nav-item[data-view]');
    if (!it) return;
    view = { type: it.dataset.view, id: it.dataset.id };
    selected.clear();
    lastClicked = -1;
    page = 0;
    render();
  });
  $('btnAddCluster').addEventListener('click', async (e) => {
    e.stopPropagation();
    const c = await editGroup('cluster');
    if (c) { view = { type: 'cluster', id: c.id }; selected.clear(); render(); }
  });
  $('btnAddList').addEventListener('click', async (e) => {
    e.stopPropagation();
    const l = await editGroup('list');
    if (l) { view = { type: 'list', id: l.id }; selected.clear(); render(); }
  });

  $('viewActions').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'rename') {
      const item = view.type === 'cluster' ? db.clusters.find((c) => c.id === view.id) : currentList();
      editGroup(view.type, item);
    } else if (act === 'remove') removeCurrentGroup();
  });

  let searchTimer;
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { page = 0; renderView(); }, 150);
  });
  $('statusFilter').addEventListener('change', () => { page = 0; renderView(); });

  $('thead').addEventListener('click', (e) => {
    if (e.target.id === 'selAll') {
      if (e.target.checked) rows.forEach((k) => selected.add(k));
      else rows.forEach((k) => selected.delete(k));
      renderView();
      return;
    }
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: key === 'f' || key === 'd' ? -1 : 1 };
    renderView();
  });

  $('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const i = +tr.dataset.i;
    const k = rows[i];
    if (e.target.matches('[data-toggle]')) {
      if (editLocked()) return;
      k.s = k.s ? 0 : 1;
      changed(`«${k.p}» → ${k.s ? 'загружено' : 'не загружено'}`);
      return;
    }
    if (e.target.matches('input[type=checkbox]')) {
      const on = e.target.checked;
      if (e.shiftKey && lastClicked >= 0) {
        const [a, b] = lastClicked < i ? [lastClicked, i] : [i, lastClicked];
        for (let j = a; j <= b; j++) on ? selected.add(rows[j]) : selected.delete(rows[j]);
      } else on ? selected.add(k) : selected.delete(k);
      lastClicked = i;
      renderView();
    }
  });

  $('pager').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (!b) return;
    page += +b.dataset.page;
    renderView();
    document.querySelector('.table-wrap').scrollTop = 0;
  });

  $('bulk').addEventListener('click', (e) => {
    const act = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (act) bulkAction(act);
  });
  $('bulkMove').addEventListener('change', (e) => moveSelected(e.target.value));

  $('btnWs').addEventListener('click', () => openWs(selected.size ? selectedArray() : rows));
  $('jobBar').addEventListener('click', (e) => {
    if (e.target.closest('[data-job=cancel]')) cancelJob();
  });
  ['wsB', 'wsQ', 'wsE', 'wsSkip'].forEach((id) => $(id).addEventListener('change', updateWsEstimate));
  $('wsRegionSel').addEventListener('change', (e) => {
    if (e.target.value !== 'custom') $('wsRegion').value = e.target.value;
    updateWsEstimate();
  });
  $('wsRegion').addEventListener('input', () => { syncRegionSelect(); updateWsEstimate(); });

  $('btnCopyAll').addEventListener('click', () => copyPhrases(rows));
  $('btnCsvAll').addEventListener('click', () => downloadCsv(rows));

  $('btnAdd').addEventListener('click', openAdd);
  $('addTarget').addEventListener('change', async (e) => {
    const sel = e.target;
    if (sel.value === 'new-cluster' || sel.value === 'new-list') {
      const type = sel.value === 'new-cluster' ? 'cluster' : 'list';
      const created = await editGroup(type);
      fillAddTargets(created ? (type === 'cluster' ? 'c:' : 'l:') + created.id : sel.dataset.prev);
    } else sel.dataset.prev = sel.value;
  });
  $('btnAddDo').addEventListener('click', () => {
    if (editLocked()) return;
    const items = parseLines($('addText').value);
    if (!items.length) { toast('Вставьте фразы — по одной на строку', true); return; }
    const target = targetFromValue($('addTarget').value);
    const rep = addPhrases(items, target, $('addLoaded').checked);
    $('addReport').innerHTML = reportHtml(rep, target);
    $('addText').value = '';
  });

  $('btnSettings').addEventListener('click', openSettings);
  $('btnSync').addEventListener('click', () => {
    if (!cfg.token) return openSettings();
    loadRemote().then(pollJob);
  });
  $('saveState').addEventListener('click', () => {
    if (!cfg.token) return openSettings();
    if (dirty || saveError) { saveError = ''; scheduleSave(0); }
  });

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close('')));

  window.addEventListener('beforeunload', (e) => {
    if (cfg.token && (dirty || saving)) { e.preventDefault(); e.returnValue = ''; }
  });
}

async function openSettings() {
  $('setToken').value = cfg.token;
  $('setOwner').value = cfg.owner;
  $('setRepo').value = cfg.repo;
  $('setBranch').value = cfg.branch;
  $('setPath').value = cfg.path;
  if ((await openDialog($('dlgSettings'))) !== 'ok') return;
  const next = {
    token: $('setToken').value.trim(),
    owner: $('setOwner').value.trim() || DEFAULT_CFG.owner,
    repo: $('setRepo').value.trim() || DEFAULT_CFG.repo,
    branch: $('setBranch').value.trim() || DEFAULT_CFG.branch,
    path: $('setPath').value.trim().replace(/^\/+/, '') || DEFAULT_CFG.path,
  };
  if (next.token && !/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(next.token)) {
    alert('Это не похоже на токен GitHub.\n\nТокен начинается с «github_pat_» и состоит примерно из 90 символов. ' +
      'Он показывается один раз — сразу после нажатия «Generate token». Если вы его не сохранили, создайте токен заново.');
    return openSettings();
  }
  const sameFile = ['owner', 'repo', 'branch', 'path'].every((k) => next[k] === cfg[k]);
  cfg = next;
  localStorage.setItem(LS_CFG, JSON.stringify(cfg));
  if (!sameFile) { sha = null; dirty = false; pendingMsgs = []; }
  saveError = '';
  lastSavedAt = null;
  job = null;
  await loadRemote();
  pollJob();
}

// ---------- старт ----------

loadLocal();
rebuildIndex();
bind();
render();
if (cfg.token) loadRemote().then(pollJob);
else openSettings();
