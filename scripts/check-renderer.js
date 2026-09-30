#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — статическая проверка renderer-а
   ──────────────────────────────────────────────────────────────────────
   Грузит все файлы интерфейса в пустую песочницу и ищет обращения к
   членам namespace, которых нет: store.foo(), ui.bar() и так далее.
   Ловит опечатки, которые иначе всплывают только на том экране,
   где ветка кода выполняется редко.

   Дёшево, без зависимостей и без запуска Electron. Запуск:
     node scripts/check-renderer.js
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', 'app');
const ORDER = [
  'js/api.js', 'js/ui.js', 'js/markdown.js', 'js/store.js', 'js/router.js',
  'js/auth.js', 'js/picker.js', 'js/common.js', 'js/notifications.js', 'js/tierboard.js', 'js/roster.js',
  'js/views/home.js', 'js/views/builds.js', 'js/views/build-editor.js',
  'js/views/tops.js', 'js/views/threads.js', 'js/views/guides.js',
  'js/views/profile.js', 'js/views/coaches.js', 'js/views/custom-items.js',
  'js/views/create.js', 'js/views/reports.js', 'js/views/admin-extra.js',
  'js/views/admin.js', 'js/main.js',
];

const noop = () => {};
const fakeEl = () => new Proxy({}, {
  get: (t, k) => {
    if (k === 'style' || k === 'dataset' || k === 'classList') return fakeEl();
    if (k === 'children' || k === 'childNodes' || k === 'parentNode') return [];
    if (k === 'value' || k === 'textContent' || k === 'innerHTML' || k === 'id') return '';
    return noop;
  },
  set: () => true,
  apply: () => fakeEl(),
});

const sandbox = {};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.location = { hash: '', href: 'http://127.0.0.1/', search: '' };
sandbox.localStorage = {
  _v: new Map(),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v) { this._v.set(k, String(v)); },
  removeItem(k) { this._v.delete(k); },
};
sandbox.document = {
  readyState: 'complete',
  title: '',
  body: fakeEl(),
  head: fakeEl(),
  createElement: () => fakeEl(),
  createTextNode: () => fakeEl(),
  getElementById: () => fakeEl(),
  querySelector: () => fakeEl(),
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
};
sandbox.history = { back: noop };
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), headers: new Map() });
sandbox.FormData = class {};
sandbox.URLSearchParams = URLSearchParams;
sandbox.MutationObserver = class { observe() {} disconnect() {} };
sandbox.IntersectionObserver = class { observe() {} disconnect() {} };
sandbox.requestAnimationFrame = cb => setTimeout(cb, 0);
sandbox.getComputedStyle = () => ({});
sandbox.matchMedia = () => ({ matches: false, addEventListener: noop });
sandbox.scrollTo = noop;
sandbox.alert = noop;
sandbox.confirm = () => true;
sandbox.prompt = () => null;
sandbox.markdownit = undefined;
sandbox.window.dotacustoms = { apiBase: '/api', web: true };

const ctx = vm.createContext(sandbox);
const failures = [];

for (const rel of ORDER) {
  const file = path.join(APP, rel);
  const src = fs.readFileSync(file, 'utf8');
  try {
    vm.runInContext(src, ctx, { filename: rel });
  } catch (err) {
    failures.push(`${rel}: не выполнился — ${err.message}`);
  }
}

/* ── собираем реальные члены каждого namespace ─────────────────────── */
function membersOf(obj) {
  const out = new Set();
  if (!obj) return out;
  let cur = obj;
  for (let depth = 0; cur && depth < 3; depth++) {
    for (const k of Object.keys(cur)) out.add(k);
    cur = Object.getPrototypeOf(cur);
  }
  return out;
}

const NAMESPACES = {
  store: sandbox.store, api: sandbox.api, ui: sandbox.ui, auth: sandbox.auth,
  router: sandbox.router, common: sandbox.common, picker: sandbox.picker,
  md: sandbox.md, views: sandbox.views,
};

console.log('=== загружено ===');
for (const [name, obj] of Object.entries(NAMESPACES)) {
  const m = membersOf(obj);
  console.log(`  ${name}: ${obj ? m.size + ' членов' : 'НЕ НАЙДЕН'}`);
  if (!obj) failures.push(`namespace ${name} не создан`);
}

console.log('\n=== ссылки в view-файлах ===');
const problems = [];
for (const rel of ORDER.slice(8)) {
  const src = fs.readFileSync(path.join(APP, rel), 'utf8');
  for (const [nsName, obj] of Object.entries(NAMESPACES)) {
    if (!obj) continue;
    const members = membersOf(obj);
    const re = new RegExp(`\\b${nsName}\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const m of src.matchAll(re)) {
      const prop = m[1];
      if (['prototype', 'call', 'apply', 'bind', 'length', 'name', 'constructor'].includes(prop)) continue;
      if (!members.has(prop)) {
        problems.push(`${rel}: ${nsName}.${prop} — нет такого члена`);
      }
    }
  }
}

const uniq = [...new Set(problems)];
if (uniq.length) {
  console.log(uniq.join('\n'));
  console.log(`\n  Замечаний: ${uniq.length}`);
} else {
  console.log('  все ссылки разрешаются');
}

if (failures.length) {
  console.log('\n=== ошибки загрузки ===');
  console.log(failures.join('\n'));
}
process.exit(uniq.length || failures.length ? 1 : 0);
