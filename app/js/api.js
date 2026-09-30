/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — API-клиент для локального сервера
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const dot = window.dotacustoms || {};
  const TOKEN_KEY = 'dc_token';
  // В Electron порт приходит из preload, но он МЕНЯЕТСЯ, когда включается
  // общий доступ по сети. Поэтому адрес спрашивается по требованию, а не
  // запоминается навсегда — иначе после переключения окно ходило бы
  // на закрытый порт.
  const START_BASE = dot.apiBase || '';
  let baseCache = null;

  async function resolveBase() {
    if (baseCache) return baseCache;
    if (dot.currentPort) {
      try {
        const p = await dot.currentPort();
        baseCache = p ? `http://127.0.0.1:${p}/api` : START_BASE;
      } catch { baseCache = START_BASE; }
    } else if (START_BASE) {
      // Отладочная обёртка и dev-сервер знают свой адрес.
      baseCache = START_BASE;
    } else {
      // Обычный браузер: приложение открыто с того же сервера, что и API.
      try { baseCache = new URL('api', location.href).href; }
      catch { baseCache = '/api'; }
    }
    if (!baseCache) baseCache = '/api';
    return baseCache;
  }

  /** Склейка адреса и пути ровно одним слешем. */
  function join(base, path) {
    if (!path) return base;
    if (/^https?:\/\//i.test(path)) return path;
    const b = String(base).replace(/\/+$/, '');
    const p = String(path).replace(/^\/+/, '');
    return p ? `${b}/${p}` : b;
  }

  /** Сбросить запомненный адрес — например, после смены порта. */
  function forgetBase() { baseCache = null; }

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

  async function call(method, url, { body, token, headers } = {}) {
    const hdrs = { 'Accept': 'application/json', ...(headers || {}) };
    const t = token ?? getToken();
    if (t) hdrs.Authorization = `Bearer ${t}`;
    if (body !== undefined && body !== null && !(body instanceof FormData)) {
      hdrs['Content-Type'] = 'application/json';
    }
    const payload = body instanceof FormData
      ? body
      : (body !== undefined ? JSON.stringify(body) : undefined);

    const send = async (base) => {
      const res = await fetch(join(base, url), {
        method,
        headers: hdrs,
        body: payload,
        credentials: 'omit',
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      return { status: res.status, ok: res.status >= 200 && res.status < 300, data, headers: res.headers };
    };

    try {
      return await send(await resolveBase());
    } catch (err) {
      // Адрес мог поменяться (переключили общий доступ) — узнаём заново
      // и пробуем ровно один раз, чтобы не зациклиться на битой сети.
      if (dot.currentPort) {
        forgetBase();
        try { return await send(await resolveBase()); } catch { /* падаем ниже */ }
      }
      throw err;
    }
  }

  window.api = {
    call, getToken, setToken, forgetBase, resolveBase,
    get: (url, opts) => call('GET', url, opts),
    post: (url, opts) => call('POST', url, opts),
    put: (url, opts) => call('PUT', url, opts),
    patch: (url, opts) => call('PATCH', url, opts),
    delete: (url, opts) => call('DELETE', url, opts),
    get BASE() { return baseCache || START_BASE || 'api'; },
  };
})();
