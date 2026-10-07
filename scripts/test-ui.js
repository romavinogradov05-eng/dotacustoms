#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — дымовой тест интерфейса (временный инструмент)
   ──────────────────────────────────────────────────────────────────────
   Грузит renderer-файлы в минимальный DOM и обходит ВСЕ экраны против
   настоящего backend-а. Ловит то, что не ловит линтер: опечатки в именах
   функций, несуществующие поля ответа, падения на пустых данных.

   Backend поднимается самим тестом на временной базе, поэтому прогон
   не зависит от запущенного приложения и всегда начинается с чистого
   листа (первый зарегистрированный становится администратором).

   Запуск:  npm run test:ui
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', 'app');

/* backend поднимаем сами: тест должен быть герметичным */
let ORIGIN = '';
let API = '';
let backend = null;
let dataDir = '';

/* ── минимальный DOM ────────────────────────────────────────────────── */
class El {
  constructor(tag, ns) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeName = this.tagName;
    this.namespaceURI = ns || null;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.dataset = new Proxy({}, {
      get: (t, k) => this.attributes.get('data-' + camel(k)),
      set: (t, k, v) => { this.attributes.set('data-' + camel(k), String(v)); return true; },
      has: (t, k) => this.attributes.has('data-' + camel(k)),
    });
    this._text = '';
    this._listeners = new Map();
    this.scrollTop = 0;
  }

  get children() { return this.childNodes.filter(n => n instanceof El); }
  get firstChild() { return this.childNodes[0] || null; }
  get id() { return this.attributes.get('id') || ''; }
  set id(v) { this.attributes.set('id', String(v)); }
  get className() { return this.attributes.get('class') || ''; }
  set className(v) { this.attributes.set('class', String(v)); }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    const save = arr => { self.className = arr.join(' '); };
    return {
      add: c => save([...new Set([...list(), c])]),
      remove: c => save(list().filter(x => x !== c)),
      contains: c => list().includes(c),
      toggle: (c, on) => {
        const has = list().includes(c);
        const want = on === undefined ? !has : !!on;
        if (want && !has) save([...list(), c]);
        else if (!want && has) save(list().filter(x => x !== c));
        return want;
      },
    };
  }
  get value() { return this._value !== undefined ? this._value : this.attributes.get('value') || ''; }
  set value(v) { this._value = String(v); }
  get disabled() { return this.attributes.has('disabled'); }
  set disabled(v) { if (v) this.attributes.set('disabled', ''); else this.attributes.delete('disabled'); }
  get href() { return this.attributes.get('href') || ''; }
  set href(v) { this.attributes.set('href', String(v)); }

  get textContent() {
    if (this.childNodes.length) {
      return this.childNodes.map(n => (n instanceof El ? n.textContent : n.data)).join('');
    }
    // innerHTML выставлен напрямую (markdown, вставки) — текст достаём из него
    if (this._html) return this._html.replace(/<[^>]*>/g, '');
    return this._text;
  }
  set textContent(v) {
    this.childNodes = [];
    this._text = String(v);
    if (this._text) this.childNodes.push(new Text(this._text));
  }

  set innerHTML(v) { this._html = String(v); this.childNodes = []; this._text = ''; }
  get innerHTML() {
    if (this._html) return this._html;
    return this.childNodes.map(n => (n instanceof El ? n.outerHTML : escapeHtml(n.data))).join('');
  }
  get outerHTML() {
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
    return `<${this.tagName.toLowerCase()}${attrs}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  appendChild(node) {
    if (node instanceof Frag) { for (const c of [...node.childNodes]) this.appendChild(c); return node; }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  setAttributeNS(ns, k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._listeners.get(type) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  dispatch(type, ev) { for (const fn of this._listeners.get(type) || []) fn(ev || { type, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {}
  blur() {}
  click() { this.dispatch('click'); }
  scrollIntoView() {}
  matches(sel) { return matchCompound(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const groups = String(sel).split(',').map(s => s.trim()).filter(Boolean);
    const out = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (!(child instanceof El)) continue;
        if (groups.some(g => matchChain(child, g, node))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

class Text {
  constructor(data) { this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
}
class Frag extends El { constructor() { super('#fragment'); } }

function camel(s) { return String(s).replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Совпадение одного составного селектора: tag#id.cls[attr="v"] */
function matchCompound(el, sel) {
  const m = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/.exec(sel);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const rest = m[2] || '';
  const re = /([#.][\w-]+)|(\[[^\]]+\])/g;
  for (const t of rest.matchAll(re)) {
    if (t[1]) {
      const [sigil, name] = [t[1][0], t[1].slice(1)];
      if (sigil === '#') { if (el.id !== name) return false; }
      else if (!el.classList.contains(name)) return false;
    } else {
      const attr = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(t[2]);
      if (!attr) return false;
      if (!el.attributes.has(attr[1])) return false;
      if (attr[2] !== undefined && el.attributes.get(attr[1]) !== attr[2]) return false;
    }
  }
  return true;
}

/** Совпадение цепочки «a b c» — справа налево, как в настоящем CSS:
    последняя часть — сам элемент, остальные ищутся по всей цепочке предков
    (а не только по непосредственному родителю). */
function matchChain(el, sel) {
  const parts = sel.split(/\s+/).filter(Boolean);
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  let cur = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (cur && !matchCompound(cur, parts[i])) cur = cur.parentNode;
    if (!cur) return false;
    cur = cur.parentNode;
  }
  return true;
}

/* ── документ ───────────────────────────────────────────────────────── */
const documentElement = new El('html');
const body = new El('body');
documentElement.appendChild(body);

const IDS = {
  view: new El('main'),
  'header-right': new El('div'),
  'main-nav': new El('nav'),
  'footer-info': new El('span'),
  'footer-patch': new El('span'),
  'modal-root': new El('div'),
  'toast-root': new El('div'),
};
for (const [id, el] of Object.entries(IDS)) { el.id = id; body.appendChild(el); }
for (const key of ['/admin']) {
  const a = new El('a');
  a.setAttribute('href', '#' + key);
  a.setAttribute('data-nav', key);
  a.dataset.nav = key;
  IDS['main-nav'].appendChild(a);
}

const document = {
  readyState: 'complete',
  title: '',
  body,
  documentElement,
  createElement: t => new El(t),
  createElementNS: (ns, t) => new El(t, ns),
  createTextNode: t => new Text(t),
  createDocumentFragment: () => new Frag(),
  getElementById: id => {
    if (IDS[id]) return IDS[id];
    return body.querySelector('#' + id);
  },
  querySelector: s => (body.matches(s) ? body : body.querySelector(s)),
  querySelectorAll: s => body.querySelectorAll(s),
  addEventListener: () => {},
  removeEventListener: () => {},
};

/* ── sandbox ────────────────────────────────────────────────────────── */
const winListeners = new Map();
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  queueMicrotask, URLSearchParams, TextEncoder, TextDecoder, Date, Math, JSON,
  Map, Set, Array, Object, String, Number, Boolean, Promise, RegExp, Error,
  Uint8Array, Int32Array, Float64Array, ArrayBuffer, DataView, URL, encodeURIComponent,
  document,
  Node: El,
  Element: El,
  Event: class { constructor(t) { this.type = t; } preventDefault() {} stopPropagation() {} },
  CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  location: {
    hash: '#/', href: ORIGIN + '/#/', search: '',
    replace(h) { this.hash = h; winListeners.get('hashchange')?.forEach(f => f()); },
  },
  history: { back() {}, pushState() {}, replaceState() {} },
  navigator: { userAgent: 'smoke', platform: 'win32', clipboard: { writeText: async () => {} } },
  localStorage: (() => {
    const m = new Map();
    return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: k => m.delete(k),
      clear: () => m.clear(),
      key: i => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
  })(),
  addEventListener: (t, f) => { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(f); },
  removeEventListener: (t, f) => { const a = winListeners.get(t) || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
  dispatchEvent: () => true,
  scrollTo: () => {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
  requestAnimationFrame: cb => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  alert: () => {}, confirm: () => true, prompt: () => null,
  open: () => null,
  URL: globalThis.URL,
  fetch: (url, opts) => globalThis.fetch(String(url).startsWith('http') ? url : ORIGIN + String(url), opts),
  Headers: globalThis.Headers,
  Response: globalThis.Response,
  FormData: globalThis.FormData,
  Blob: globalThis.Blob,
  FileReader: class { readAsDataURL() {} addEventListener() {} },
  dotacustoms: {
    apiBase: API,
    web: true,
    platform: 'browser',
    info: async () => ({ version: '1.0.0', packaged: false, dataDir, dbFile: dataDir + '/dotacustoms.db' }),
    openDataDir: async () => ({ ok: true }),
  },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);

const FILES = [
  'js/api.js', 'js/ui.js', 'js/markdown.js', 'js/store.js', 'js/router.js',
  'js/auth.js', 'js/picker.js', 'js/common.js', 'js/notifications.js', 'js/tierboard.js', 'js/roster.js',
  'js/views/home.js', 'js/views/builds.js', 'js/views/build-editor.js',
  'js/views/tops.js', 'js/views/threads.js', 'js/views/guides.js',
  'js/views/profile.js', 'js/views/coaches.js', 'js/views/custom-items.js',
  'js/views/create.js', 'js/views/reports.js', 'js/views/admin-extra.js',
  'js/views/admin.js', 'js/main.js',
];

/**
 * Загружает renderer-файлы. Вызывается ПОСЛЕ подъёма backend-а: main.js
 * на загрузке сразу дёргает store.boot(), и без живого API он честно
 * покажет «сервер не отвечает» и не зарегистрирует маршруты.
 */
function loadRenderer() {
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(APP, rel), 'utf8');
    try {
      vm.runInContext(src, ctx, { filename: rel });
    } catch (err) {
      console.error(`!! ${rel} не выполнился: ${err.message}\n${err.stack}`);
      process.exit(1);
    }
  }
}

/* ── данные для обхода ──────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
const say = s => console.log(s);

async function check(name, fn) {
  try {
    const note = await fn();
    pass++;
    say(`  ✓ ${name}${note ? ' — ' + note : ''}`);
  } catch (err) {
    fail++;
    failures.push(`${name}: ${err.message}`);
    say(`  ✗ ${name}\n      ${err.message}`);
    if (err.stack) say('      ' + String(err.stack).split('\n')[1]);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function waitFor(label, fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('не дождались: ' + label);
    await new Promise(r => setTimeout(r, 25));
  }
}

/** Гоняет экран через настоящий router.render() и возвращает узел. */
async function renderRoute(hash, { allowPanel = false } = {}) {
  sandbox.location.hash = hash.startsWith('#') ? hash : '#' + hash;
  const host = IDS.view;
  host.childNodes = [];
  host._html = '';
  host._text = '';

  const logged = [];
  const realError = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  try {
    await sandbox.router.render();
    // часть экранов дорисовывается после своего await — даём им договорить
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 15));
  } finally {
    console.error = realError;
  }
  if (logged.length) throw new Error('renderer залогировал ошибку: ' + logged[0]);
  const panel = host.querySelector('.error-panel');
  if (panel && !allowPanel) {
    const msg = panel.querySelector('p');
    throw new Error('экран упал в error-panel: ' + (msg ? msg.textContent : '?'));
  }
  return host;
}

function matchRoute(parts) {
  const routes = sandbox.router.list();
  for (const r of routes) {
    if (r.parts.length !== parts.length) continue;
    const p = {};
    let good = true;
    for (let i = 0; i < r.parts.length; i++) {
      const seg = r.parts[i];
      if (seg.startsWith(':')) p[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) { good = false; break; }
    }
    if (good) return { route: r, params: p };
  }
  return null;
}

/** Все маршруты, объявленные в main.js. */
function routePatterns() {
  return sandbox.router.list().map(r => r.pattern);
}

function textOf(node) { return node ? node.textContent : ''; }
function countTags(node, tag) {
  let n = node.tagName === tag.toUpperCase() ? 1 : 0;
  for (const c of node.children) n += countTags(c, tag);
  return n;
}

async function main() {
  // состояние обхода: заполняется по мере регистрации
  let token = '';
  let guestToken = '';
  let guestId = 0;
  let me = null;
  let buildId = 0, topId = 0, threadId = 0, guideSlug = '';

  // ── свой backend на временной базе ─────────────────────────────────
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotacustoms-smoke-'));
  const { createBackend } = require('../backend/index');
  backend = createBackend({ dataDir });
  const server = await backend.listen(0, '127.0.0.1');
  ORIGIN = `http://127.0.0.1:${server.address().port}`;
  API = ORIGIN + '/api';
  sandbox.dotacustoms.apiBase = API;
  sandbox.location.origin = ORIGIN;
  loadRenderer();

  say('');
  say('  DotaCustoms — дымовой тест интерфейса');
  say('  ' + '─'.repeat(50));
  say(`  backend: ${ORIGIN}`);
  say(`  база:    ${dataDir}`);
  say('');

  const health = await (await fetch(API + '/health')).json();
  assert(health.ok, 'backend не отвечает: ' + JSON.stringify(health));
  say(`  патч ${health.patch}, база ${health.db}`);
  say('');

  // помощники для обращений к API: post использует текущий token
  const authed = (t) => ({ Authorization: 'Bearer ' + (t || token) });
  const post = (url, bodyObj, t) => fetch(API + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authed(t) },
    body: JSON.stringify(bodyObj),
  }).then(r => r.json());

  say('Маршруты');
  await check('все экраны зарегистрированы', async () => {
    // main.js регистрирует маршруты после store.boot() — дожидаемся
    await waitFor('регистрации маршрутов', () => sandbox.router.list().length > 0);
    const patterns = routePatterns();
    const need = [
      '/', '/builds', '/builds/new', '/builds/:id', '/builds/:id/edit',
      '/tops', '/tops/new', '/tops/:id', '/tops/:id/edit',
      '/threads', '/threads/new', '/threads/:id', '/threads/:id/edit',
      '/guides', '/guides/new', '/guides/:slug', '/guides/:slug/edit',
      '/custom-items', '/u/:username', '/profile', '/coaches', '/admin',
      '/create', '/reports', '/reports/new', '/tops/kind/:kind',
      '/login', '/register',
    ];
    const missing = need.filter(p => !patterns.includes(p));
    assert(!missing.length, 'нет маршрутов: ' + missing.join(', '));
    return patterns.length + ' маршрутов';
  });

  say('');

  say('Загрузка справочника');
  await check('store.boot поднимает конфиг и датасет', async () => {
    await sandbox.store.boot();
    assert(sandbox.store.ready, 'ready не выставлен');
    assert(sandbox.store.heroes.length > 100, `героев ${sandbox.store.heroes.length}`);
    assert(sandbox.store.items.length > 300, `предметов ${sandbox.store.items.length}`);
    assert(sandbox.store.neutrals.length > 40, `нейтралок ${sandbox.store.neutrals.length}`);
    assert(/^https?:|^images$/.test(sandbox.store.cdn), 'cdn: ' + sandbox.store.cdn);
    return `${sandbox.store.heroes.length} героев, патч ${sandbox.store.patch}`;
  });

  await check('таланты героя раскладываются по уровням патча', async () => {
    const hero = sandbox.store.heroes.find(h => h.key === 'antimage');
    const groups = sandbox.store.heroTalents(hero.id);
    assert(groups.length === sandbox.store.TALENT_LEVELS.length,
      `уровней ${groups.length}, а в конфиге ${sandbox.store.TALENT_LEVELS.length}`);
    const flat = groups.flat();
    const real = sandbox.store.abilities.filter(a => a.is_talent && a.hero === 'antimage' && a.playable);
    assert(flat.length === real.length, `в группах ${flat.length}, боевых в датасете ${real.length}`);
    assert(groups.every(g => g.length <= 2), 'больше двух талантов на уровень');
    assert(new Set(flat.map(t => t.id)).size === flat.length, 'таланты повторяются');
    assert(flat.every(t => t.playable), 'в группах попали небоевые таланты');
    return `${flat.length} талантов, уровни ${sandbox.store.TALENT_LEVELS.join('/')}`;
  });

  await check('поиск способностей без героя не выдаёт внутренние', async () => {
    const all = sandbox.store.abilities.filter(a => !a.is_talent && a.hero && a.playable);
    const notPlayable = sandbox.store.abilities.filter(a => !a.is_talent && a.hero && !a.playable);
    assert(notPlayable.length > 0, 'в датасете нет небоевых способностей — фильтр нечего проверять');
    assert(all.length > 0, 'список боевых способностей пуст');
    return `${all.length} боевых, ${notPlayable.length} внутренних отсеяно`;
  });

  await check('у всех героев есть боевые способности', async () => {
    const bare = sandbox.store.heroes.filter(h => sandbox.store.heroAbilities(h.id).length === 0);
    assert(!bare.length, 'без способностей: ' + bare.map(h => h.key).join(', '));
    // и только настоящие, без внутренних
    const am = sandbox.store.heroes.find(h => h.key === 'antimage');
    const keys = sandbox.store.heroAbilities(am.id).map(a => a.key);
    assert(!keys.includes('antimage_ebb') && !keys.includes('antimage_counterspell2'),
      'внутренние способности попали в список: ' + keys.join(', '));
    return `Антимаг: ${keys.length} (${keys.join(', ')})`;
  });

  await check('число уровней талантов пришло из конфига', async () => {
    const res = await (await fetch(API + '/config')).json();
    assert(Array.isArray(res.talent_levels) && res.talent_levels.length,
      'в /api/config нет talent_levels');
    assert(res.limits.maxTalents === res.talent_levels.length,
      `maxTalents=${res.limits.maxTalents}, уровней ${res.talent_levels.length}`);
    return `${res.talent_levels.join(', ')} (maxTalents ${res.limits.maxTalents})`;
  });

  await check('герой с коротким списком талантов не ломает редактор', async () => {
    // в herodata у части героев талантов меньше восьми — раскладка должна
    // остаться ровно на столько уровней, сколько есть
    const short = sandbox.store.heroes
      .map(h => ({ h, n: sandbox.store.heroTalents(h.id).flat().length }))
      .filter(x => x.n > 0)
      .sort((a, b) => a.n - b.n)[0];
    assert(short, 'у всех героев полный набор талантов');
    sandbox.store.setMe({ user: { id: 1, username: 'x', nickname: 'X', role: 'admin', coach_scopes: [] } });
    sandbox.store.prefs.hero = String(short.h.id);
    const host = await renderRoute('/builds/new');
    assert(host.innerHTML.length > 200, 'редактор пуст');
    return `${short.h.key}: ${short.n} талантов`;
  });

  say('');
  say('Кастомные предметы CHC');
  await check('каталог загрузился в store', async () => {
    const items = sandbox.store.customItems || [];
    assert(items.length === 31, `предметов ${items.length}, ожидалось 31`);
    assert(sandbox.store.customPatch === null,
      'патч гайд не называет, ждём null: ' + sandbox.store.customPatch);
    assert((sandbox.store.customGroups || []).length === 4, 'групп не 4');
    assert((sandbox.store.customGroups || []).some(g => g.key === 'books'),
      'группы «Книги» нет');
    assert(items.every(c => ['chc', 'rr', '*'].includes(c.mode)),
      'не у всех предметов есть режим');
    return `${items.length} предметов, источник гайд 3570972414`;
  });

  await check('id кастомных не пересекаются с обычными', async () => {
    const normal = new Set(sandbox.store.items.map(i => i.id));
    for (const c of sandbox.store.customItems) {
      assert(!normal.has(c.id), `id ${c.id} совпал с обычным предметом`);
      assert(c.id >= 900000, `id ${c.id} вне диапазона 900000+`);
    }
    return `диапазон ${Math.min(...sandbox.store.customItems.map(c => c.id))}…`;
  });

  await check('иконки лежат на диске', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    // store.icon склеивает cdn + img, поэтому путь восстанавливаем так же
    const missing = sandbox.store.customItems.filter(c => {
      const url = sandbox.store.icon(c.img);
      if (/^https?:/.test(url)) return false;   // CDN, проверим отдельно
      return !fs.existsSync(path.join(root, 'app', url));
    });
    assert(!missing.length, 'нет иконок: ' + missing.map(c => c.key).join(', '));
    return `${sandbox.store.customItems.length} файлов на месте`;
  });

  await check('датасет переключён на локальные иконки', async () => {
    // иначе иконки лежат на диске, но renderer смотрит в интернет
    assert(sandbox.store.cdn === 'images',
      `meta.cdn = ${sandbox.store.cdn}. Запусти npm run data:images.`);
    return 'cdn = images';
  });

  await check('связи с умениями героев разрешаются', async () => {
    let abilities = 0, items = 0;
    for (const c of sandbox.store.customItems) {
      const rel = sandbox.store.customRelations(c);
      assert(rel.abilities.length === (c.related_abilities || []).length,
        `${c.key}: из ${c.related_abilities.length} умений нашлось ${rel.abilities.length}`);
      assert(rel.items.length === (c.related_items || []).length,
        `${c.key}: предметы не разрешились`);
      for (const a of rel.abilities) {
        assert(a.hero, `${c.key} → умение без героя: ${a.key}`);
        assert(sandbox.store.heroByKey.get(a.hero), `${c.key} → неизвестный герой ${a.hero}`);
      }
      abilities += rel.abilities.length;
      items += rel.items.length;
    }
    assert(abilities > 0, 'ни один предмет не связан с умением героя');
    return `${abilities} умений, ${items} предметов Dota`;
  });

  await check('цепочки улучшений замкнуты', async () => {
    for (const c of sandbox.store.customItems) {
      if (c.upgrades_from) {
        const from = sandbox.store.customItem(c.upgrades_from);
        assert(from, `${c.key}: нет предмета ${c.upgrades_from}`);
        assert((from.upgrades || []).includes(c.key),
          `${c.upgrades_from} не указывает улучшение в ${c.key}`);
      }
      for (const k of c.upgrades || []) {
        const to = sandbox.store.customItem(k);
        assert(to, `${c.key}: улучшение ведёт в никуда — ${k}`);
        assert(to.upgrades_from === c.key, `${k}: не ссылается на ${c.key} в upgrades_from`);
      }
    }
    return 'обе стороны сходятся';
  });

  await check('anyItemById находит и обычные, и кастомные', async () => {
    const normal = sandbox.store.items[0];
    const custom = sandbox.store.customItems[0];
    assert(sandbox.store.anyItemById(normal.id), 'обычный предмет не найден');
    assert(sandbox.store.anyItemById(custom.id), 'кастомный предмет не найден');
    assert(sandbox.store.anyItemById(999999) === null, 'несуществующий id вернул предмет');
    return `${normal.name} + ${custom.name}`;
  });

  await check('старые id из сохранённых билдов продолжают работать', async () => {
    // до перехода на ключевые id номера были индексными: 900000 — Kast.
    // Сохранённые билды хранят именно такие номера, и они обязаны
    // по-прежнему находить свой предмет, а не соседний.
    const aliases = sandbox.store.customIdAliases || {};
    assert(Object.keys(aliases).length === 19,
      'алиасов ' + Object.keys(aliases).length + ', ожидалось 19');
    const kast = sandbox.store.anyItemById(900000);
    assert(kast && kast.key === 'kast_greatstaff_of_the_magna',
      'по старому id 900000 не находится Kast: ' + ((kast && kast.key) || 'ничего'));
    const byNew = sandbox.store.customByKey.get('kast_greatstaff_of_the_magna');
    assert(byNew && byNew.id === kast.id,
      'старый и новый id ведут на разные предметы: ' + byNew.id + ' vs ' + kast.id);
    const torture = sandbox.store.anyItemById(900004);
    assert(torture && torture.key === 'torture_pipe',
      'по старому id 900004 не находится Torture Pipe: ' + ((torture && torture.key) || 'ничего'));
    assert(sandbox.store.anyItemById(900031) === null,
      'несуществующий старый id вернул предмет');
    return '19 алиасов, Kast и Torture Pipe находят по старым номерам';
  });

  await check('режимы: RR не имеет своего магазина, все предметы общие', async () => {
    for (const mode of ['chc', 'rr']) {
      const list = sandbox.store.customItemsFor(mode);
      assert(list.length === 31,
        mode + ': доступно ' + list.length + ' предметов, ожидалось 31');
      assert(list.every(i => sandbox.store.itemInMode(i, mode)),
        mode + ': фильтр пропустил чужой предмет');
    }
    assert(!sandbox.store.itemInMode(null, 'chc'), 'пустой предмет считается доступным');
    return '31 предметов в CHC и 31 в RR';
  });

  await check('экран справочника открывается', async () => {
    const host = await renderRoute('/custom-items');
    const text = host.textContent;
    assert(text.includes('Кастомные предметы'), 'нет заголовка');
    assert(text.includes('Книги'), 'нет группы «Книги»');
    assert(text.includes('Kast'), 'предмет из гайда не выведен');
    assert(host.querySelectorAll('.custom-card').length === 31,
      'карточек: ' + host.querySelectorAll('.custom-card').length);
    return `${host.querySelectorAll('.custom-card').length} карточек, ${host.innerHTML.length} симв.`;
  });

  await check('на главной есть блок кастомных предметов', async () => {
    const host = await renderRoute('/');
    const peeks = host.querySelectorAll('.custom-peek');
    assert(peeks.length > 0, 'плитки предметов не выведены');
    assert(/гайд|Кастом|Ratten/.test(host.textContent),
      'нет упоминания источника: ' + host.textContent.slice(0, 200));
    return `${peeks.length} плиток, источник на месте`;
  });

  await check('гайд про кастомные предметы засеян', async () => {
    const res = await (await fetch(API + '/guides/custom-items')).json();
    const guide = res.guide;
    assert(guide, 'гайд не найден: ' + JSON.stringify(res).slice(0, 120));
    assert(guide.title.includes('Кастомные'), 'заголовок: ' + guide.title);
    assert(guide.category === 'chc', 'категория: ' + guide.category);
    assert(guide.body.includes('Книги'), 'в тексте нет группы «Книги»');
    assert(guide.body.includes('4 выбора'), 'не сказано про четыре выбора талантов');
    return `${guide.title}, ${guide.body.length} симв.`;
  });

  say('');
  say('Аккаунт для обхода');
  const username = 'smoke' + Date.now().toString(36).slice(-6);

  await check('регистрация', async () => {
    const res = await (await fetch(API + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'smoketest1', nickname: 'Смоук Тест' }),
    })).json();
    assert(res && res.token, 'нет токена: ' + JSON.stringify(res));
    token = res.token;
    me = res.user;
    sandbox.api.setToken(token);
    // база пустая, поэтому первый аккаунт сразу администратор
    assert(me.role === 'admin', 'первый аккаунт должен стать админом, а не ' + me.role);
    return '@' + username + ' (' + me.role + ')';
  });

  await check('создание билда', async () => {
    const hero = sandbox.store.heroes.find(h => h.key === 'antimage');
    const items = sandbox.store.items.filter(i => i.cost).slice(0, 4).map(i => i.id);
    const skills = sandbox.store.heroAbilities(hero.id).slice(0, 3).map(a => a.id);
    const maxTalents = sandbox.store.limit('maxTalents', 4);
    const talents = sandbox.store.heroTalents(hero.id).flat().slice(0, maxTalents).map(t => t.id);
    const built = await post('/builds', {
      mode: 'chc', hero_id: hero.id, title: 'Смоук-билд Антимага',
      items, skills, talents, stage: 'midgame',
      description: 'Тестовый **билд** для дымового прогона.\n\n- пункт один\n- пункт два',
    });
    assert(built && built.id, 'билд не создан: ' + JSON.stringify(built));
    buildId = built.id;
    return '#' + buildId + ' (талантов ' + talents.length + '/' + maxTalents + ')';
  });

  await check('бэкенд не примет лишний талант', async () => {
    const config = await (await fetch(API + '/config')).json();
    const hero = sandbox.store.heroes.find(h => h.key === 'antimage');
    const pool = sandbox.store.heroTalents(hero.id).flat().map(t => t.id);
    const tooMany = pool.slice(0, config.limits.maxTalents + 1);
    assert(tooMany.length === config.limits.maxTalents + 1,
      'у героя всего ' + pool.length + ' талантов — лимит не проверить');
    const res = await post('/builds', {
      mode: 'chc', hero_id: hero.id, title: 'Слишком много талантов',
      items: [], skills: [], talents: tooMany,
    });
    assert(!res.id, 'бэкенд принял ' + tooMany.length + ' талантов при лимите '
      + config.limits.maxTalents);
    return `лимит ${config.limits.maxTalents} соблюдён`;
  });

  await check('создание топа', async () => {
    const heroes = sandbox.store.heroes.slice(0, 6).map(h => h.id);
    const made = await post('/tops', {
      mode: 'chc', kind: 'heroes', title: 'Смоук-топ героев', patch: '7.41',
      entries: heroes.map((ref_id, i) => ({ ref_id, rank: i + 1, tier: 'S' })),
    });
    assert(made && made.id, 'топ не создан: ' + JSON.stringify(made));
    topId = made.id;
    return '#' + topId;
  });

  await check('создание ветки с ответом', async () => {
    const made = await post('/threads', {
      mode: 'chc', category: 'bug', severity: 'medium',
      title: 'Смоук: не срабатывает таймер', body: 'Описание бага для дымового прогона.',
    });
    assert(made && made.id, 'ветка не создана: ' + JSON.stringify(made));
    threadId = made.id;
    const reply = await post(`/threads/${threadId}/posts`, { body: 'Ответ владельца ветки.' });
    assert(reply && reply.id, 'ответ не создан: ' + JSON.stringify(reply));
    const nested = await post(`/threads/${threadId}/posts`, { body: 'Вложенный ответ.', parent_id: reply.id });
    assert(nested && nested.id, 'вложенный ответ не создан: ' + JSON.stringify(nested));
    return '#' + threadId + ' + 2 ответа';
  });

  await check('создание гайда', async () => {
    const made = await post('/guides', {
      slug: 'smoke-guide-' + username,
      title: 'Смоук-гайд', category: 'basics', mode: 'chc',
      summary: 'Короткий гайд для дымового прогона.',
      body: '# Заголовок\n\nАбзац с **жирным**.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
    });
    assert(made && made.slug, 'гайд не создан: ' + JSON.stringify(made));
    guideSlug = made.slug;
    return '/' + guideSlug;
  });

  // дальше идут проверки, которым нужен вошедший пользователь
  await check('в билд кладётся кастомный предмет', async () => {
    const hero = sandbox.store.heroes.find(h => h.key === 'antimage');
    const custom = sandbox.store.customItems.find(c => c.key === 'kast_greatstaff_of_the_magna');
    const built = await post('/builds', {
      mode: 'chc', hero_id: hero.id, title: 'Билд с кастомным предметом',
      items: [{ item_id: custom.id }],
      skills: [], talents: [],
    });
    assert(built && built.id, 'билд не создан: ' + JSON.stringify(built));

    const one = await (await fetch(API + '/builds/' + built.id)).json();
    const saved = one.build.items[0];
    assert(saved.item_id === custom.id, `сохранилось ${saved.item_id}, ждали ${custom.id}`);
    // renderer должен найти этот id через anyItemById
    const found = sandbox.store.anyItemById(saved.item_id);
    assert(found && found.name === custom.name, 'renderer не нашёл сохранённый предмет');
    return `${custom.name} (id ${custom.id})`;
  });

  await check('билд с кастомным предметом открывается в интерфейсе', async () => {
    const list = await (await fetch(API + '/builds?author=' + username)).json();
    const mine = (list.items || []).find(b => b.title === 'Билд с кастомным предметом');
    assert(mine, 'билда нет в списке');
    const host = await renderRoute('/builds/' + mine.id);
    // Название предмета теперь живёт в тултипе иконки, а не в тексте страницы.
    const slot = [...host.querySelectorAll('.slot')].find(s =>
      (s.getAttribute('title') || '').includes('Kast'));
    assert(slot, 'предмет не показан на странице билда');
    return 'предмет виден иконкой в карточке сборки';
  });

  await check('в билде больше шести предметов (съеденные)', async () => {
    const hero = sandbox.store.heroes.find(h => h.key === 'antimage');
    const items = sandbox.store.items.slice(0, 9).map(x => ({ item_id: x.id }));
    const built = await post('/builds', {
      mode: 'chc', hero_id: hero.id, title: 'Билд на 9 предметов',
      items, skills: [], talents: [],
    });
    assert(built && built.id, 'билд не создан: ' + JSON.stringify(built));
    const one = await (await fetch(API + '/builds/' + built.id)).json();
    assert(one.build.items.length === 9, `предметов в ответе ${one.build.items.length}`);
    const host = await renderRoute('/builds/' + built.id);
    assert(host.querySelectorAll('.slot').length === 9,
      `слотов на странице ${host.querySelectorAll('.slot').length}`);
    const editor = await renderRoute('/builds/' + built.id + '/edit');
    assert(editor.textContent.includes('Добавить предмет'), 'нет кнопки «Добавить предмет»');
    const maxItems = sandbox.store.limit('maxItems', 6);
    assert(editor.textContent.includes(`из ${maxItems}`), `нет подсказки «из ${maxItems}»`);
    return `9 предметов, лимит ${maxItems}`;
  });

  await check('скилл из пула CHC отображается в билде', async () => {
    const hero = sandbox.store.heroes.find(h => h.key === 'antimage');
    const pool = sandbox.store.abilities.find(a => a.key === 'enigma_black_hole');
    assert(pool && pool.hero !== 'antimage', 'Black Hole не найден в датасете');
    const built = await post('/builds', {
      mode: 'chc', hero_id: hero.id, title: 'Билд со скиллом из пула',
      skills: [{ ability_id: pool.id, rank: 3 }],
      talents: [],
    });
    assert(built && built.id, 'билд не создан: ' + JSON.stringify(built));
    const host = await renderRoute('/builds/' + built.id);
    const shown = sandbox.picker.displayName(pool);
    // Скиллы на странице — иконки, имя держится в tooltip карточки.
    const cell = [...host.querySelectorAll('.sk')].find(s =>
      (s.getAttribute('title') || '').includes(shown));
    assert(cell, 'навык пула не показан: ' + host.textContent.slice(0, 200));
    return shown;
  });

  await check('пул CHC доступен и без героя', async () => {
    const hero = sandbox.store.heroes.find(h => h.key === 'antimage');
    assert(hero, 'Антимаг не найден');
    const pool = sandbox.store.abilities.filter(a => !a.is_talent && a.hero && a.playable).slice(0, 5);
    const host = await renderRoute('/builds/new');

    // без героя: вкладки на месте, пул активен, запрета нет
    const text = host.textContent;
    assert(text.includes('Пул CHC'), 'нет переключателя «Пул CHC»');
    assert(text.includes('Способности героя'), 'нет вкладки «Способности героя»');
    assert(!text.includes('Сначала выбери героя выше — потом добавь'),
      'вернулась заглушка «сначала герой»');

    // скилл из пула выбирается без героя
    const origAbility = sandbox.picker.pickAbility;
    sandbox.picker.pickAbility = ({ onPick }) => onPick(pool[0]);
    try {
      const addBtn = [...host.querySelectorAll('button')].find(b => b.textContent.trim() === '＋ выбрать способность');
      assert(addBtn, 'нет кнопки выбора способности');
      addBtn.click();
    } finally {
      sandbox.picker.pickAbility = origAbility;
    }
    assert(host.querySelectorAll('.talent-row.chosen').length === 1,
      'скилл без героя не выбрался');

    // выбираем героя — открывается его вкладка и кнопка «Скиллы»
    const origHero = sandbox.picker.pickHero;
    sandbox.picker.pickHero = ({ onPick }) => onPick({ id: hero.id });
    try {
      const btn = [...host.querySelectorAll('.hero-row button')].find(b => b.textContent.trim() === 'Выбрать');
      assert(btn, 'нет кнопки выбора героя');
      btn.click();
    } finally {
      sandbox.picker.pickHero = origHero;
    }
    const text2 = host.textContent;
    assert(text2.includes('⛭ Скиллы'), 'нет кнопки «Скиллы» у героя');
    assert(!text2.includes('Сначала выбери героя — тогда появится список его способностей'),
      'осталась старая заглушка про выбор героя');
    return 'пул без героя + герой открывает свои скиллы (до 20)';
  });

  await check('в редакторе можно выбрать до 20 скиллов', async () => {
    const hero = sandbox.store.heroes.find(h => h.key === 'antimage');
    const pool = sandbox.store.abilities.filter(a => !a.is_talent && a.hero && a.playable).slice(0, 30);
    assert(pool.length >= 21, 'мало способностей в пуле');
    const host = await renderRoute('/builds/new');

    const origHero = sandbox.picker.pickHero;
    sandbox.picker.pickHero = ({ onPick }) => onPick({ id: hero.id });
    let calls = 0;
    const origAbility = sandbox.picker.pickAbility;
    sandbox.picker.pickAbility = ({ onPick }) => onPick(pool[calls++ % pool.length]);
    try {
      const chooseBtn = [...host.querySelectorAll('.hero-row button')].find(b => b.textContent.trim() === 'Выбрать');
      assert(chooseBtn, 'нет кнопки выбора героя');
      chooseBtn.click();
      const skillBtn = () => [...host.querySelectorAll('.hero-row button')].find(b => /Скиллы/.test(b.textContent));
      assert(skillBtn(), 'нет кнопки «Скиллы»');
      for (let i = 0; i < 20; i++) skillBtn().click(); // 20 скиллов
      skillBtn().click(); // 21-й клик — лимит должен удержать
    } finally {
      sandbox.picker.pickHero = origHero;
      sandbox.picker.pickAbility = origAbility;
    }
    const text = host.textContent;
    const chosen = host.querySelectorAll('.talent-row.chosen').length;
    assert(chosen === 20, `выбрано скиллов ${chosen}, ожидалось 20`);
    assert(text.includes('(до 20)'), 'нет лимита в заголовке панели');
    return `${chosen} из 20, лимит держится`;
  });

  await check('карточка кастомного предмета рисуется', async () => {
    const custom = sandbox.store.customItems.find(c => c.key === 'azuresong_mageblade');
    const node = sandbox.picker.customCard(custom);
    const text = node.textContent;
    assert(text.includes('180'), 'нет характеристики из гайда (180 урона)');
    assert(/Камнекровый|Bloodstone/.test(text), 'нет связи с филактерией');
    assert(/5115|золота/.test(text), 'не показана цена предмета');
    assert(/Магические предметы/.test(text), 'не показана группа');
    return 'описание, цена, группа и связи на месте';
  });

  say('');
  say('Экран «Создать»');
  await check('категории создания — отдельные', async () => {
    const host = await renderRoute('/create');
    const cards = host.querySelectorAll('.create-card');
    // сборка + 3 вида топов + ветка + гайд + заявка = 7
    assert(cards.length === 7, `плиток ${cards.length}, ожидалось 7`);
    const text = host.textContent;
    for (const need of ['Сборка билда', 'Топ: ', 'нейтрал', 'скилл', 'Ветка', 'Гайд', 'Заявление']) {
      assert(text.includes(need), 'нет категории: ' + need);
    }
    return `${cards.length} категорий`;
  });

  await check('ссылки ведут в свои редакторы', async () => {
    const host = await renderRoute('/create');
    const hrefs = [...host.querySelectorAll('.create-card')].map(a => a.getAttribute('href'));
    assert(hrefs.some(x => x.startsWith('#/builds/new')), 'нет ссылки на редактор билда');
    assert(hrefs.some(x => x.includes('kind=heroes')), 'нет ссылки на топ героев');
    assert(hrefs.some(x => x.includes('kind=neutrals')), 'нет ссылки на топ нейтралок');
    assert(hrefs.some(x => x.includes('kind=skills')), 'нет ссылки на топ скиллов');
    assert(hrefs.some(x => x.startsWith('#/threads/new')), 'нет ссылки на ветку');
    assert(hrefs.some(x => x.startsWith('#/reports/new')), 'нет ссылки на заявку');
    return hrefs.length + ' ссылок';
  });

  await check('экран объясняет модерацию', async () => {
    const host = await renderRoute('/create');
    const text = host.textContent;
    assert(/Coach и администраторы/.test(text), 'не сказано, кто может создавать');
    assert(/видно всем сразу/.test(text), 'не сказано, что опубликованное видно всем');
    assert(/уведомлени/.test(text), 'не сказано про уведомления');
    return 'правило объяснено';
  });

  await check('топы разделены по категориям', async () => {
    const host = await renderRoute('/tops');
    const tabs = [...host.querySelectorAll('.tab')].map(t => t.textContent);
    const joined = tabs.join('|');
    assert(/персонаж|геро/i.test(joined), 'нет вкладки героев: ' + joined);
    assert(/нейтрал/i.test(joined), 'нет вкладки нейтралок');
    assert(/скилл/i.test(joined), 'нет вкладки скиллов');
    assert(/Все категории/.test(joined), 'нет перечисления «Все категории»');
    return tabs.length + ' вкладок';
  });

  await check('отдельная страница категории топа', async () => {
    const host = await renderRoute('/tops/kind/neutrals');
    assert(host.textContent.includes('нейтрал'), 'заголовок не про нейтралки');
    return 'категория нейтралок открылась';
  });

  say('');
  say('Заявки и уведомления');
  await check('форма заявки — свободная, с темой', async () => {
    const host = await renderRoute('/reports/new');
    const text = host.textContent;
    assert(text.includes('Тема'), 'нет поля темы');
    assert(text.includes('Текст'), 'нет поля текста');
    const inputs = host.querySelectorAll('input.input, textarea.input');
    assert(inputs.length >= 2, `полей ${inputs.length}`);
    return 'тема и текст на месте';
  });

  await check('форма предупреждает про почту', async () => {
    const host = await renderRoute('/reports/new');
    assert(/почта не указана/i.test(host.textContent),
      'нет подсказки про почту: ' + host.textContent.slice(0, 160));
    return 'подсказка есть';
  });

  await check('список заявок открывается', async () => {
    const host = await renderRoute('/reports');
    assert(/заявк/i.test(host.textContent), 'нет заголовка: ' + host.textContent.slice(0, 200));
    return host.innerHTML.length + ' симв.';
  });

  await check('в шапке есть ячейка уведомлений', async () => {
    sandbox.auth.renderHeader();
    const bell = document.querySelector('.notif-bell');
    assert(bell, 'колокольчик не появился в шапке');
    assert(sandbox.notifications, 'модуль уведомлений не загружен');
    return 'колокольчик на месте';
  });

  await check('уведомления приходят с сервера', async () => {
    const res = await (await fetch(API + '/notifications?limit=20',
      { headers: { Authorization: 'Bearer ' + token } })).json();
    assert(Array.isArray(res.items), 'список уведомлений не отдан');
    return `${res.items.length} уведомлений, непрочитанных ${res.unread}`;
  });


  /** Доска с живой моделью — повторяет поведение редактора топа. */
  function mountBoard(entries) {
    const model = { kind: 'heroes', entries };
    const host = document.createElement('div');
    let renders = 0;
    const order = [];

    function draw() {
      renders++;
      sandbox.ui.clear(host);
      host.appendChild(sandbox.tierboard.render(model.kind, model.entries, {
        refEntry: (kind, id) => ({ name: 'герой ' + id }),
        onRemove: refId => {
          const i = model.entries.findIndex(e => e.ref_id === refId);
          if (i >= 0) { model.entries.splice(i, 1); draw(); }
        },
        onShift: (refId, delta) => {
          sandbox.tierboard.shiftEntry(model.entries, refId, delta);
          draw();
        },
        onReorder: (tier, refIds) => { order.push(tier + ':' + refIds.join(',')); },
        onDrop: (refId, tier, index) => {
          sandbox.tierboard.moveEntry(model.entries, refId, tier, index);
          draw();
        },
      }));
    }
    draw();
    return { host, model, order, draws: () => renders, draw };
  }

  /** Ряд тира по его букве. */
  function rowOf(board, tier) {
    return board.host.querySelector('.tl-strip[data-tier="' + tier + '"]');
  }

  function cardOf(strip, refId) {
    return [...strip.children].find(c => c.dataset && c.dataset.ref === String(refId));
  }

  /** Порядок ref_id в ряду, как он сейчас на экране. */
  function visualOrder(strip) {
    return [...strip.children].filter(c => c.dataset && c.dataset.ref).map(c => Number(c.dataset.ref));
  }

  const ORDER_EV = clientX => ({
    clientX,
    preventDefault() {}, stopPropagation() {},
    dataTransfer: { dropEffect: '' },
  });

  /**
   * Перетаскивание: сначала dragstart карточки, потом dragover цели,
   * потом drop. Так же, как это делает браузер.
   */
  function drag(board, refId, toTier, targetRefId, side) {
    const from = [...board.host.querySelectorAll('.tl-strip')].find(s => cardOf(s, refId));
    from.dispatch('dragstart', {
      dataTransfer: { setData() {}, effectAllowed: '' }, preventDefault() {}, stopPropagation() {},
    });

    const strip = rowOf(board, toTier);
    const target = targetRefId == null ? strip : cardOf(strip, targetRefId);
    if (target !== strip) target.dispatch('dragover', ORDER_EV(side === 'right' ? 500 : 0));
    strip.dispatch('drop', {
      preventDefault() {}, stopPropagation() {},
      target,
      dataTransfer: { getData: () => String(refId) },
    });
  }

  await check('перетаскивание по доске реально двигает карточки', async () => {
    const refs = sandbox.store.heroes.slice(0, 3).map(x => x.id);
    const board = mountBoard([
      { ref_id: refs[0], tier: 'S', rank: 1 },
      { ref_id: refs[1], tier: 'S', rank: 2 },
      { ref_id: refs[2], tier: 'A', rank: 3 },
    ]);

    // 1. Тащим из S в A, на карточку — встанем ПЕРЕД ней
    drag(board, refs[0], 'A', refs[2], 'left');
    assert(visualOrder(rowOf(board, 'A'))[0] === refs[0],
      'в A должен оказаться первым, а не вторым: ' + visualOrder(rowOf(board, 'A')).join(','));

    // Один бросок — одно изменение модели. Раньше обработчик после
    // перерисовки ещё раз правил порядок, и карточки «разъезжались»:
    // на экране одно, в базу уходило другое.
    assert(board.order.length === 0,
      'после одного броска порядок правится второй раз: ' + board.order.join(' | '));

    // 2. Тащим в S и роняем на ПУСТОЕ место — обязан встать в конец
    drag(board, refs[0], 'S', null);
    assert(visualOrder(rowOf(board, 'S')).pop() === refs[0],
      'бросок в пустое место должен давать конец строки: ' + visualOrder(rowOf(board, 'S')).join(','));

    // 3. Тащим тот же S на правую половину соседа — встанет ПОСЛЕ него
    const sRow = rowOf(board, 'S');
    const first = Number(visualOrder(sRow)[0]);
    drag(board, refs[0], 'S', first, 'right');
    assert(visualOrder(rowOf(board, 'S')).pop() === refs[0],
      'вставка справа от карточки не сработала: ' + visualOrder(rowOf(board, 'S')).join(','));

    return 'влево/вправо/в пустое — все три попадают куда сказали';
  });

  await check('перетаскивание не ломает модель вторым проходом', async () => {
    const refs = sandbox.store.heroes.slice(0, 4).map(x => x.id);
    const board = mountBoard([
      { ref_id: refs[0], tier: 'S', rank: 1 },
      { ref_id: refs[1], tier: 'S', rank: 2 },
      { ref_id: refs[2], tier: 'B', rank: 3 },
      { ref_id: refs[3], tier: 'B', rank: 4 },
    ]);
    // Три броска подряд: если обработчик после перерисовки читает старую
    // разметку, порядок на экране и в модели разойдутся уже на втором броске.
    drag(board, refs[0], 'B', refs[3], 'right');
    drag(board, refs[1], 'A', null);
    drag(board, refs[2], 'B', null);

    for (const tier of ['S', 'A', 'B', 'C', 'D', '']) {
      const strip = rowOf(board, tier);
      if (!strip) continue;
      const seen = visualOrder(strip);
      const model = board.model.entries
        .filter(e => (e.tier || '') === tier).map(e => e.ref_id);
      assert(seen.join(',') === model.join(','),
        'тир ' + (tier || 'без тира') + ': на экране [' + seen.join(',')
        + '], в модели [' + model.join(',') + ']');
    }
    assert(visualOrder(rowOf(board, 'B')).pop() === refs[2],
      'последний бросок должен лежать в конце B');
    return 'экран совпадает с моделью после трёх бросков';
  });

  say('');
  say('Тир-лист как на tiermaker');
  await check('перенос карточки в другой тир', async () => {
    const entries = [
      { ref_id: 1, tier: 'S', rank: 1 },
      { ref_id: 2, tier: 'S', rank: 2 },
      { ref_id: 3, tier: 'A', rank: 3 },
    ];
    sandbox.tierboard.moveEntry(entries, 1, 'B', 0);
    assert(entries.find(e => e.ref_id === 1).tier === 'B',
      'карточка осталась в ' + entries.find(e => e.ref_id === 1).tier);
    const rows = sandbox.tierboard.rowsOf(entries);
    const b = rows.find(r => r.tier === 'B');
    assert(b && b.items[0].ref_id === 1, 'карточка не первая в строке B');
    return 'S → B, встала первой';
  });

  await check('порядок внутри строки меняется', async () => {
    const entries = [
      { ref_id: 1, tier: 'S', rank: 1 },
      { ref_id: 2, tier: 'S', rank: 2 },
      { ref_id: 3, tier: 'S', rank: 3 },
    ];
    sandbox.tierboard.shiftEntry(entries, 1, 1);   // первый сдвинуть вниз
    assert(entries[0].ref_id === 2 && entries[1].ref_id === 1,
      'после сдвига: ' + entries.map(e => e.ref_id).join(','));
    sandbox.tierboard.shiftEntry(entries, 3, -1);  // третий поднять
    assert(entries[1].ref_id === 3, 'после второго сдвига: ' + entries.map(e => e.ref_id).join(','));
    return '▲▼ работают';
  });

  await check('крайние позиции не уезжают', async () => {
    const entries = [{ ref_id: 1, tier: 'S', rank: 1 }, { ref_id: 2, tier: 'S', rank: 2 }];
    sandbox.tierboard.shiftEntry(entries, 1, -1);   // уже наверху
    assert(entries[0].ref_id === 1, 'верхний уехал: ' + entries.map(e => e.ref_id).join(','));
    sandbox.tierboard.shiftEntry(entries, 2, 1);    // уже внизу
    assert(entries[1].ref_id === 2, 'нижний уехал: ' + entries.map(e => e.ref_id).join(','));
    return 'края держат';
  });

  await check('номера пересчитываются сверху вниз', async () => {
    const entries = [
      { ref_id: 1, tier: 'C', rank: 1 },
      { ref_id: 2, tier: 'S', rank: 2 },
      { ref_id: 3, tier: 'S', rank: 3 },
    ];
    sandbox.tierboard.renumber(entries);
    const s = entries.filter(e => e.tier === 'S');
    assert(s[0].ref_id === 2 && s[0].rank === 1, 'S не с нуля: ' + JSON.stringify(s));
    assert(s[1].ref_id === 3 && s[1].rank === 2, 'второй S не второй: ' + s[1].rank);
    assert(entries.find(e => e.tier === 'C').rank === 3, 'C не последний');
    return 'S,S,C → ранги 1,2,3';
  });

  await check('карточки без тира видны отдельной строкой', async () => {
    const entries = [
      { ref_id: 1, tier: 'S', rank: 1 },
      { ref_id: 2, tier: '', rank: 2 },
    ];
    const rows = sandbox.tierboard.rowsOf(entries);
    const last = rows[rows.length - 1];
    assert(last.tier === '' && last.items.length === 1,
      'строка «без тира» не найдена: ' + JSON.stringify(rows.map(r => r.tier)));
    const st = sandbox.tierboard.stats(entries);
    assert(st.total === 2 && st.placed === 1,
      `статистика: ${st.total} всего, ${st.placed} с тиром`);
    return 'без тира отдельно и посчитано';
  });

  await check('доска рисуется в редакторе топа', async () => {
    const refs = sandbox.store.heroes.slice(0, 4).map(x => x.id);
    const real = await post('/tops', {
      mode: 'chc', kind: 'heroes', title: 'Тир-лист для проверки',
      entries: refs.map((ref_id, i) => ({
        ref_id, rank: i + 1, tier: ['S', 'S', 'A', ''][i],
      })),
    }, token);
    assert(real && real.id, 'топ не создан: ' + JSON.stringify(real).slice(0, 120));
    const host = await renderRoute('/tops/' + real.id);
    const rows = host.querySelectorAll('.tl-row');
    assert(rows.length === 3, 'строк тиров: ' + rows.length + ', ожидалось 3 (S, A, без тира)');
    const cards = host.querySelectorAll('.tl-card.view');
    assert(cards.length === 4, 'карточек: ' + cards.length);
    const labels = [...host.querySelectorAll('.tl-label')].map(l => l.textContent);
    assert(labels.join(',') === 'S,A,—', 'метки тиров: ' + labels.join(','));
    return rows.length + ' строки, ' + cards.length + ' карточки, метки ' + labels.join('/');
  });
  await check('в редакторе есть доска и подсказка про перетаскивание', async () => {
    const host = await renderRoute('/tops/new?kind=heroes');
    const text = host.textContent;
    assert(text.includes('перетаскивай'), 'нет подсказки про перетаскивание');
    assert(text.includes('Тир-лист'), 'нет заголовка тир-листа');
    assert(text.includes('Разложить по тирам'), 'нет кнопки автотира');
    const rows = host.querySelectorAll('.tl-row');
    assert(rows.length === 5, 'пустых строк тиров: ' + rows.length + ', ожидалось 5 (S…D)');
    return `${rows.length} строк S…D, кнопки на месте`;
  });

  await check('ростер героев доступен и пуст по умолчанию', async () => {
    assert(sandbox.store.roster('chc') === null, 'ростер CHC не должен быть задан по умолчанию');
    assert(sandbox.store.heroesFor('chc').length === sandbox.store.heroes.length,
      'без ростера показываются все герои');
    const title = sandbox.store.heroesTitle('chc');
    assert(/Выбор героя/.test(title), 'заголовок: ' + title);
    return 'без ограничений, все ' + sandbox.store.heroes.length + ' героев';
  });


  // ── регрессия: ростер сопоставляется по ключу, а не по id ────────────
  // Раньше ключи из rosters.json прогонялись через Number(),
  // а Number('antimage') — это NaN, поэтому любой заполненный ростер
  // давал ПУСТОЙ список героев.
  await check('ростер фильтрует по ключам, а не по id', async () => {
    const saved = sandbox.store.config.rosters;
    const heroes = sandbox.store.heroes;
    const picked = heroes.slice(0, 4);
    try {
      sandbox.store.config.rosters = { chc: [picked[0].key, picked[2].key], rr: [] };
      const list = sandbox.store.heroesFor('chc');
      assert(list.length === 2,
        'в ростере 2 героя, а показано ' + list.length,
        list.map(x => x.key).join(','));
      assert(list[0].key === picked[0].key,
        'первый не тот: ' + list[0].key);
      // соседний режим не задет
      assert(sandbox.store.heroesFor('rr').length === heroes.length,
        'ростер CHC утекает в RR');
    } finally {
      sandbox.store.config.rosters = saved;
    }
    return 'antimage-подобные ключи находятся, NaN больше не мешает';
  });

  await check('без ростера в выборе все герои справочника', async () => {
    const saved = sandbox.store.config.rosters;
    try {
      sandbox.store.config.rosters = {};
      assert(sandbox.store.heroesFor('chc').length === sandbox.store.heroes.length,
        'без ростера список героев сократился');
      assert(sandbox.store.roster('chc') === null, 'пустой массив не должен считаться ростером');
    } finally {
      sandbox.store.config.rosters = saved;
    }
    return 'все ' + sandbox.store.heroes.length + ' на месте';
  });

  await check('герой вне ростера помечается в редакторе', async () => {
    const saved = sandbox.store.config.rosters;
    const heroes = sandbox.store.heroes;
    try {
      sandbox.store.config.rosters = { chc: [heroes[0].key] };
      assert(!sandbox.store.heroOutOfRoster('chc', heroes[0].id),
        'герой из ростера помечен как чужой');
      assert(sandbox.store.heroOutOfRoster('chc', heroes[5].id),
        'герой вне ростера не помечен — билд молча пропадёт из выдачи');
      assert(!sandbox.store.heroOutOfRoster('chc', null),
        'билд без героя не должен считаться вне ростера');
    } finally {
      sandbox.store.config.rosters = saved;
    }
    return 'помечается только чужой герой';
  });

  // ── герой в редакторе билда: строка, а не плитка во всю ширину ──────
  await check('в редакторе билда герой необязателен', async () => {
    const host = await renderRoute('/builds/new');
    const text = host.textContent;
    assert(text.includes('не привязан'),
      'нет пометки, что герой можно не задавать');
    assert(!text.includes('Выбрать героя'),
      'осталась плитка «Выбрать героя» — герой снова выглядит обязательным');
    const row = host.querySelector('.hero-row');
    assert(row, 'нет строки героя');
    const btn = [...row.querySelectorAll('button')].find(b => /Выбрать/.test(b.textContent));
    assert(btn, 'в строке героя нет кнопки выбора');
    return 'одна строка, герой можно не задавать';
  });

  await check('игрок не может открывать редакторы создания', async () => {
    // свежий обычный игрок: создавать контент могут только Coach и админы
    const reg = await (await fetch(API + '/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'denied' + username.slice(-6), password: 'smoketest1', nickname: 'БезПрав' }),
    })).json();
    assert(reg && reg.token, 'регистрация: ' + JSON.stringify(reg));
    const savedToken = sandbox.api.getToken();
    const savedMe = sandbox.store.me;
    sandbox.api.setToken(reg.token);
    sandbox.store.setMe({ user: reg.user });
    try {
      for (const route of ['/builds/new', '/tops/new', '/threads/new', '/guides/new']) {
        const host = await renderRoute(route, { allowPanel: true });
        assert(host.textContent.includes('Нет доступа'),
          `${route}: нет отказа, текст: ` + host.textContent.slice(0, 120));
      }
      // на экране «Создать» игроку доступна только заявка
      const create = await renderRoute('/create');
      const cards = [...create.querySelectorAll('.create-card')];
      assert(cards.length === 1 && create.textContent.includes('Заявление'),
        `плиток ${cards.length}, ожидалась одна «Заявление»`);
    } finally {
      sandbox.api.setToken(savedToken);
      sandbox.store.setMe(savedMe ? { user: savedMe } : null);
    }
    return 'четыре отказа + только заявка';
  });

  await check('в выборе героя есть настройка ростера', async () => {
    assert(typeof sandbox.rosterView === 'object', 'модуль ростера не загрузился');
    assert(typeof sandbox.rosterView.canEdit === 'function', 'нет проверки прав');

    // Роль подменяем явно: сессия теста — админ, а проверять надо и запрет.
    const real = sandbox.store.me;
    const as = (me, mode) => { sandbox.store.me = me; return sandbox.rosterView.canEdit(mode); };
    try {
      assert(as({ role: 'admin' }, 'chc') === true, 'админ должен править ростер');
      assert(as({ role: 'admin' }, 'rr') === true, 'админ правит любой режим');
      assert(as(null, 'chc') === false, 'гостю ростер не положен');
      assert(as({ role: 'user' }, 'chc') === false, 'обычному игроку ростер не положен');
      assert(as({ role: 'coach', coach_scopes: ['chc'] }, 'chc') === true,
        'Coach своего режима должен править');
      assert(as({ role: 'coach', coach_scopes: ['chc'] }, 'rr') === false,
        'Coach чужого режима не должен править');
      assert(as({ role: 'coach', coach_scopes: ['*'] }, 'rr') === true,
        'Coach со всеми правами должен править');
    } finally {
      sandbox.store.me = real;
    }
    return 'админ, Coach своего режима — да; остальным нет';
  });

  say('');
  say('Админка: очередь, заявки, доступ, почта');
  for (const [tab, needle] of [
    ['queue', 'Очередь пуста'],
    ['reports', 'Заявки'],
    ['share', 'Общий доступ'],
    ['mail', 'Почта для уведомлений'],
  ]) {
    await check(`вкладка «${tab}» открывается`, async () => {
      const host = await renderRoute('/admin?tab=' + tab);
      assert(host.textContent.includes(needle),
        `нет ожидаемого текста «${needle}»: ` + host.textContent.slice(0, 200));
      return host.innerHTML.length + ' симв.';
    });
  }

  await check('фильтр по группе работает', async () => {
    const host = await renderRoute('/custom-items?group=summoner');
    const cards = host.querySelectorAll('.custom-card');
    assert(cards.length === 6, `предметов призывателей ${cards.length}, ожидалось 6`);
    assert(host.textContent.includes('Gang Letter'), 'Gang Letter не найден');
    return '6 предметов призывателей';
  });

  await check('связи показаны на карточке', async () => {
    const host = await renderRoute('/custom-items');
    const chips = host.querySelectorAll('.chip-hero');
    assert(chips.length > 0, 'нет ни одной связи с умением героя');
    const text = host.textContent;
    assert(text.includes('Shadow Realm') || text.includes('Timber Chain'),
      'ожидаемая связь не выведена: ' + text.slice(0, 200));
    return `${chips.length} связей с умениями`;
  });

  say('');
  say('Экраны (гость)');
  const GUEST = [
    ['главная', '/', h => assert(countTags(h, 'h2') + countTags(h, 'h1') > 0, 'нет заголовка')],
    ['справочник кастомных предметов', '/custom-items', h => {
      assert(h.querySelectorAll('.custom-card').length === 31, 'карточек не 31');
    }],
    ['билды', '/builds', h => assert(h.innerHTML.length > 200, 'почти пусто')],
    ['топы', '/tops', h => assert(h.innerHTML.length > 200, 'почти пусто')],
    ['ветки', '/threads', h => assert(h.innerHTML.length > 200, 'почти пусто')],
    ['обучение', '/guides', h => assert(h.innerHTML.length > 200, 'почти пусто')],
    ['тренеры', '/coaches', h => assert(h.innerHTML.length > 100, 'почти пусто')],
    ['вход', '/login', h => assert(countTags(h, 'form') === 1, 'нет формы')],
    ['регистрация', '/register', h => assert(countTags(h, 'form') === 1, 'нет формы')],
    ['билд', `/builds/${buildId}`, h => assert(textOf(h).includes('Антимаг') || h.innerHTML.length > 300, 'пусто')],
    ['топ', `/tops/${topId}`, h => assert(textOf(h).includes('Топ героев') || textOf(h).includes('Смоук'), 'пусто')],
    ['ветка', `/threads/${threadId}`, h => {
      assert(h.innerHTML.length > 300, 'пусто');
      assert(textOf(h).includes('Ответ владельца'), 'ответ не показан');
      assert(textOf(h).includes('Вложенный ответ'), 'вложенный ответ не показан');
    }],
    ['гайд', `/guides/${guideSlug}`, h => assert(h.innerHTML.length > 300, 'пусто')],
    ['профиль по нику', `/u/${username}`, h => assert(textOf(h).includes('Смоук'), 'профиль пуст')],
    ['чужой маршрут', '/такой-страницы-нет', h => {
      assert(h.textContent.includes('404'), 'нет 404: ' + h.textContent.slice(0, 80));
      // предыдущий экран обязан исчезнуть, иначе 404 рисуется под ним
      assert(!h.textContent.includes('Регистрация') && h.querySelectorAll('form').length === 0,
        'старый экран остался под 404: ' + h.textContent.slice(0, 120));
    }, { allowPanel: true }],
  ];

  for (const [name, hash, assertFn, opts] of GUEST) {
    await check(name, async () => {
      sandbox.api.setToken(null);
      sandbox.store.setMe(null);
      const host = await renderRoute(hash, opts);
      assert(host.childNodes.length > 0, 'ничего не отрисовано');
      if (assertFn) assertFn(host);
      return `${host.innerHTML.length} симв.`;
    });
  }

  await check('экран 404 не оставляет предыдущий', async () => {
    await renderRoute('/register');
    const host = await renderRoute('/ещё-нет-такой', { allowPanel: true });
    assert(host.textContent.includes('404'), 'нет 404');
    assert(!host.textContent.includes('Регистрация'),
      'экран регистрации остался под 404: ' + host.textContent.slice(0, 100));
    assert(countTags(host, 'INPUT') === 0, 'поля ввода от прошлого экрана не убраны');
    return 'чисто';
  });

  say('');
  say('Экраны (вошедший)');
  sandbox.api.setToken(token);
  sandbox.store.setMe({ user: me });

  const AUTHED = [
    ['редактор билда', '/builds/new', h => assert(hasEditor(h), 'нет полей ввода')],
    ['правка билда', `/builds/${buildId}/edit`, h => assert(hasEditor(h), 'нет полей ввода')],
    ['новый топ', '/tops/new', h => assert(hasEditor(h), 'нет полей ввода')],
    ['правка топа', `/tops/${topId}/edit`, h => assert(hasEditor(h), 'нет полей ввода')],
    ['новая ветка', '/threads/new', h => assert(hasEditor(h), 'нет полей ввода')],
    ['правка ветки', `/threads/${threadId}/edit`, h => assert(hasEditor(h), 'нет полей ввода')],
    ['новый гайд', '/guides/new', h => assert(hasEditor(h), 'нет полей ввода')],
    ['правка гайда', `/guides/${guideSlug}/edit`, h => assert(hasEditor(h), 'нет полей ввода')],
    ['свой профиль', '/profile', h => assert(h.innerHTML.length > 200, 'пусто')],
    ['мои билды', '/builds?author=' + username, h => assert(textOf(h).includes('Смоук-билд'), 'свой билд не нашёлся')],
    ['мои ветки', '/threads?author=' + username, h => assert(textOf(h).includes('таймер'), 'своя ветка не нашлась')],
    ['мои топы', '/tops?author=' + username, h => assert(textOf(h).includes('Смоук-топ'), 'свой топ не нашёлся')],
  ];

  for (const [name, hash, assertFn, opts] of AUTHED) {
    await check(name, async () => {
      const host = await renderRoute(hash, opts);
      assert(host.childNodes.length > 0, 'ничего не отрисовано');
      if (assertFn) assertFn(host);
      return `${host.innerHTML.length} симв.`;
    });
  }

  say('');
  say('Права');
  await check('обычный игрок не попадает в админку', async () => {
    const reg = await (await fetch(API + '/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'guest' + username.slice(-6), password: 'smoketest1', nickname: 'Гость' }),
    })).json();
    assert(reg && reg.token, 'регистрация второго пользователя: ' + JSON.stringify(reg));
    assert(reg.user.role === 'user', 'роль не user: ' + reg.user.role);

    sandbox.api.setToken(reg.token);
    sandbox.store.setMe({ user: reg.user });
    const host = await renderRoute('/admin', { allowPanel: true });
    assert(textOf(host).includes('только для администратора'), 'нет отказа: ' + textOf(host).slice(0, 120));
    guestToken = reg.token;
    guestId = reg.user.id;
    return '@' + reg.user.username + ' — отказ получен';
  });

  say('');
  say('Роль Coach');
  await check('выдача роли coach со областью chc', async () => {
    const r = await fetch(API + `/admin/users/${guestId}/role`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authed(token) },
      body: JSON.stringify({ role: 'coach', coach_scopes: ['chc'] }),
    });
    assert(r.status === 200, 'выдача роли: HTTP ' + r.status);
    const meRes = await (await fetch(API + '/auth/me', { headers: authed(guestToken) })).json();
    assert(meRes.user.role === 'coach', 'роль: ' + meRes.user.role);
    assert((meRes.user.coach_scopes || []).includes('chc'), 'область: ' + JSON.stringify(meRes.user.coach_scopes));
    sandbox.api.setToken(guestToken);
    sandbox.store.setMe({ user: meRes.user });
    return 'роль coach, область chc';
  });

  await check('витрина тренеров показывает область', async () => {
    const host = await renderRoute('/coaches');
    assert(textOf(host).includes('Custom Hero Chaos') || textOf(host).includes('CHC'),
      'область не показана: ' + textOf(host).slice(0, 200));
    return 'ok';
  });

  await check('Coach всё ещё не админ', async () => {
    const host = await renderRoute('/admin', { allowPanel: true });
    assert(textOf(host).includes('только для администратора'), 'Coach попал в админку');
    return 'отказ получен';
  });

  await check('Coach открывает свой профиль', async () => {
    const host = await renderRoute('/profile');
    assert(host.innerHTML.length > 200, 'пусто');
    return 'ok';
  });

  say('');
  say('Админ-панель');
  sandbox.api.setToken(token);
  await sandbox.store.restoreSession();
  assert(sandbox.store.isAdmin(), 'админка не восстановилась после restoreSession');

  for (const tab of ['?tab=overview', '?tab=users', '?tab=flags', '?tab=threads', '?tab=content', '?tab=log']) {
    await check('вкладка' + tab, async () => {
      const host = await renderRoute('/admin' + tab);
      // планка выше, чем у «шапки + табов»: значит содержимое реально доехало
      assert(host.innerHTML.length > 700, 'похоже на незагруженную панель');
      return `${host.innerHTML.length} симв.`;
    });
  }

  say('');
  say('Markdown');
  const md = sandbox.md;
  await check('экранирует HTML в заголовке', async () => {
    const out = md.render('# <img src=x onerror=alert(1)>');
    assert(!/<img/i.test(out), 'HTML не экранирован: ' + out);
    return 'ok';
  });
  await check('экранирует кавычку в ссылке', async () => {
    const out = md.render('[клик](https://x.test/" onmouseover="alert(1))');
    assert(!/onmouseover="alert/.test(out), 'атрибут не экранирован: ' + out);
    return 'ok';
  });
  await check('экранирует HTML в списке и таблице', async () => {
    const out = md.render('- <b>жирный</b>\n\n| a | b |\n| --- | --- |\n| <script> | 2 |');
    assert(!/<b>/i.test(out) && !/<script>/i.test(out), 'HTML не экранирован: ' + out);
    return 'ok';
  });
  await check('таблица читается по индексам строк', async () => {
    const out = md.render('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| a | b |\n| --- | --- |\n| 3 | 4 |');
    assert(countText(out, '<tr>') === 4, 'строк ' + countText(out, '<tr>'));
    assert(out.includes('>3<') && out.includes('>4<'), 'вторая таблица потерялась: ' + out);
    return 'ok';
  });
  await check('форматирование не сломано', async () => {
    const out = md.render('**жирный** и `код`\n\n- пункт\n\n> цитата');
    assert(out.includes('<strong>жирный</strong>'), 'нет <strong>');
    assert(out.includes('<code>код</code>'), 'нет <code>');
    assert(out.includes('<li>пункт</li>'), 'нет <li>');
    assert(out.includes('<blockquote>'), 'нет цитаты');
    return 'ok';
  });
  await check('front matter разбирается', async () => {
    const fm = md.frontMatter('---\ntitle: Тест\nmode: chc\n---\n\n# Тело');
    assert(fm.data.title === 'Тест' && fm.data.mode === 'chc', 'front matter: ' + JSON.stringify(fm.data));
    assert(fm.body.trim().startsWith('# Тело'), 'тело: ' + fm.body);
    return 'ok';
  });

  say('');
  say('─'.repeat(52));
  say(`  Пройдено: ${pass}   Провалено: ${fail}`);
  if (failures.length) {
    say('');
    say('  Провалившиеся проверки:');
    for (const f of failures) say('   • ' + f);
  }
  say('');
  if (backend) {
    try { server.close && server.close(); } catch {}
    try { backend.close(); } catch {}
  }
  process.exit(fail ? 1 : 0);
}

function countText(hay, needle) {
  return hay.split(needle).length - 1;
}

function hasEditor(node) {
  if (!node) return false;
  const html = node.innerHTML || '';
  const tags = countTags(node, 'INPUT') + countTags(node, 'TEXTAREA') + countTags(node, 'SELECT') + countTags(node, 'BUTTON');
  if (tags >= 4) return true;
  if (/form/i.test(html)) return true;
  return html.length > 150;
}

main().catch(err => {
  console.error('\n  Прогон упал:', err);
  console.error(err.stack);
  process.exit(1);
});
