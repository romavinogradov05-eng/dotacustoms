/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — хеш-роутер
   ──────────────────────────────────────────────────────────────────────
   Маршруты вида #/builds/12?tab=comments. Разбираем в
   { path, parts, query } и отдаём нужному экрану. Роуты описаны в
   app.js, здесь — только механика перехода.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const routes = [];
  let notFound = null;
  let current = null;
  let onBefore = null;

  /** pattern: '/builds/:id' — двоеточие означает параметр. */
  function register(pattern, handler, meta) {
    const parts = pattern.split('/').filter(Boolean);
    routes.push({ pattern, parts, handler, meta: meta || {} });
  }

  function setNotFound(handler) { notFound = handler; }

  /** Что вызывать перед каждой навигацией (например, снять фокус). */
  function setBefore(fn) { onBefore = fn; }

  function parse() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const qi = raw.indexOf('?');
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const query = {};
    if (qi >= 0) {
      for (const [k, v] of new URLSearchParams(raw.slice(qi + 1))) query[k] = v;
    }
    return { path, parts: path.split('/').filter(Boolean), query, raw };
  }

  function match(url) {
    for (const route of routes) {
      if (route.parts.length !== url.parts.length) continue;
      const params = {};
      let good = true;
      for (let i = 0; i < route.parts.length; i++) {
        const seg = route.parts[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(url.parts[i]);
        else if (seg !== url.parts[i]) { good = false; break; }
      }
      if (good) return { route, params };
    }
    return null;
  }

  function go(path, { replace } = {}) {
    const target = path.startsWith('#') ? path : '#' + (path.startsWith('/') ? path : '/' + path);
    if (location.hash === target) { render(); return; }
    if (replace) location.replace(target);
    else location.hash = target;
  }

  function buildUrl(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== null && v !== undefined && v !== '') qs.set(k, v);
    }
    const q = qs.toString();
    return '#' + path + (q ? '?' + q : '');
  }

  function replaceQuery(params) {
    const url = parse();
    go(url.path + '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''))
    ).toString());
  }

  async function render() {
    const url = parse();
    const found = match(url);
    if (onBefore) onBefore(current, url);
    current = url;

    markActiveNav(url.parts[0] || '');

    const host = document.getElementById('view');
    if (!host) return;

    // гасим предыдущий экран, чтобы не мигал старый контент
    ui.clear(host);
    host.setAttribute('aria-busy', 'true');

    try {
      if (found) {
        await found.route.handler(host, found.params, url.query);
      } else if (notFound) {
        await notFound(host, url);
      }
    } catch (err) {
      console.error('[dotacustoms] экран не отрисовался:', err);
      ui.clear(host);
      host.appendChild(ui.h('div.error-panel', [
        ui.h('h3', { text: 'Не удалось открыть страницу' }),
        ui.h('p', { text: err && err.message ? err.message : String(err) }),
        ui.h('div.btn-row', { style: { marginTop: '14px' } },
          ui.h('button.btn.btn-primary', { type: 'button', text: 'На главную', onclick: () => go('/') })),
      ]));
    } finally {
      host.removeAttribute('aria-busy');
      if (typeof found === 'object' && found && !found.route.meta.keepScroll) host.scrollTop = 0;
      window.scrollTo(0, 0);
    }
  }

  function markActiveNav(section) {
    for (const a of document.querySelectorAll('#main-nav a')) {
      const nav = a.dataset.nav.replace(/^\//, '');
      a.classList.toggle('active', nav === section || (nav === '' && section === ''));
    }
  }

  function start() {
    window.addEventListener('hashchange', render);
    render();
  }

  /** Таблица маршрутов — для отладки и дымовых тестов. */
  function list() {
    return routes.map(r => ({ pattern: r.pattern, parts: r.parts.slice(), meta: r.meta }));
  }

  window.router = { register, setNotFound, setBefore, go, buildUrl, replaceQuery, render, start, parse, list };
})();
