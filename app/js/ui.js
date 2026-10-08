/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — мелкие помощники DOM
   Никаких зависимостей: э, $ и набор коробочек вместо фреймворка.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';

  /**
   * h('div.card', { onclick }, [child, 'text'])
   * Имя тега может содержать CSS-селектор в суффиксе: tag#id.a.b
   */
  function h(spec, props, children) {
    if (Array.isArray(props) || typeof props === 'string' || props instanceof Node) {
      children = props;
      props = {};
    }
    props = props || {};
    const m = /^([a-zA-Z0-9-]+)?(#[^.\s]+)?((?:\.[^.\s#]+)*)$/.exec(spec) || [];
    const tag = m[1] || 'div';
    const el = document.createElement(tag);
    if (m[2]) el.id = m[2].slice(1);
    if (m[3]) el.className = m[3].slice(1).split('.').join(' ');

    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') {
        el.className = [el.className, v].filter(Boolean).join(' ');
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k === 'dataset' && typeof v === 'object') {
        Object.assign(el.dataset, v);
      } else if (k === 'html') {
        el.innerHTML = v;
      } else if (k === 'text') {
        el.textContent = String(v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
        el.value = v;
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }

    append(el, children);
    return el;
  }

  function append(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(c => append(parent, c)); return; }
    if (child instanceof Node) { parent.appendChild(child); return; }
    parent.appendChild(document.createTextNode(String(child)));
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Полностью очищает узел. */
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

  /** Создаёт <svg><image href=…></svg> — так работают иконки предметов Dota.
      wide = true — прямоугольный кадр 88×64 (широкие иконки, напр. предметы),
      иначе квадрат 64×64 (умения, айтемы-квадраты). */
  function dotaIcon(src, cls, wide) {
    const img = document.createElementNS(SVG_NS, 'image');
    img.setAttributeNS(XLINK_NS, 'xlink:href', src);
    img.setAttribute('href', src);
    img.setAttribute('width', '100%');
    img.setAttribute('height', '100%');
    img.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', wide ? '0 0 88 64' : '0 0 64 64');
    svg.setAttribute('class', cls || 'icon');
    svg.appendChild(img);
    return svg;
  }

  /** Время «5 минут назад» из ISO-строки. */
  function ago(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
    const table = [[31536000, 'год'], [2592000, 'мес'], [604800, 'нед'], [86400, 'дн'], [3600, 'ч'], [60, 'мин']];
    for (const [sec, word] of table) {
      if (s >= sec) {
        const n = Math.floor(s / sec);
        const plural = n >= 11 && n % 10 <= 4 && !(n % 100 >= 11 && n % 100 <= 14) ? word + 'а' : word;
        const plural5 = n % 10 === 1 ? '' : (n % 10 >= 2 && n % 10 <= 4 ? word + 'а' : plural);
        return `${n} ${plural5 || word}`;
      }
    }
    return 'только что';
  }

  /** Склонение: plural(5, 'билд', 'билда', 'билдов'). */
  function plural(n, one, few, many) {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;
    return many;
  }

  function debounce(fn, ms) {
    let t = 0;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms || 220);
    };
  }

  /** Точка в конце фразы — по числу. */
  const items = n => `${n} ${plural(n, 'штука', 'штуки', 'штук')}`;

  // ── всплывающие сообщения ───────────────────────────────────────────
  function toast(text, kind, ms) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const el = h(`div.toast${kind ? '.' + kind : ''}`, { text: String(text) });
    root.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(24px)';
      setTimeout(() => el.remove(), 260);
    }, ms || 3400);
  }
  const ok = t => toast(t, 'ok');
  const err = t => toast(t, 'err', 5000);

  /** Показывает ошибку API: если это 401 — предлагает войти. */
  function apiError(res, fallback) {
    const msg = (res && res.data && res.data.error) || fallback || 'Что-то пошло не так';
    if (res && res.status === 401 && window.app && window.app.openLogin) {
      window.app.openLogin('Нужно войти в аккаунт');
    }
    err(msg);
    return msg;
  }

  // ── модальные окна ──────────────────────────────────────────────────
  const modalStack = [];

  function closeModal() {
    const top = modalStack.pop();
    if (top) top.remove();
  }

  /**
   * modal({ title, body, actions, wide }) → { el, close }
   * body   — узел или функция(api), возвращающая узел
   * actions — [{ label, kind, onClick(api), close }]
   */
  function modal({ title, body, actions, wide, onClose } = {}) {
    const root = document.getElementById('modal-root');
    const backdrop = h('div.modal-backdrop', {
      onclick: e => { if (e.target === backdrop) close(); },
    });
    const box = h(`div.modal${wide ? '.modal-wide' : ''}`);
    const bodyBox = h('div.modal-body');
    const foot = actions && actions.length ? h('div.modal-foot') : null;

    const api = { close, body: bodyBox };
    backdrop.appendChild(box);
    box.appendChild(h('div.modal-head', [
      h('h3', { text: title || '' }),
      h('button.icon-btn', { type: 'button', title: 'Закрыть', text: '×', onclick: close }),
    ]));
    box.appendChild(bodyBox);
    if (foot) {
      for (const a of actions) {
        foot.appendChild(h(`button.btn${a.kind ? '.btn-' + a.kind : ''}`, {
          type: 'button',
          text: a.label,
          onclick: async () => {
            if (a.onClick) {
              const res = await a.onClick(api);
              if (res === false) return;
            }
            if (a.close !== false) close();
          },
        }));
      }
      box.appendChild(foot);
    }

    const content = typeof body === 'function' ? body(api) : body;
    if (content) append(bodyBox, content);

    function close() {
      const idx = modalStack.indexOf(api);
      if (idx >= 0) modalStack.splice(idx, 1);
      backdrop.remove();
      if (onClose) onClose();
    }

    backdrop._close = close;
    modalStack.push(api);
    root.appendChild(backdrop);
    const focusable = box.querySelector('input, textarea, select, button.btn-primary');
    if (focusable) setTimeout(() => focusable.focus(), 40);
    return api;
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modalStack.length) closeModal();
  });

  /** Модалка подтверждения. Возвращает Promise<boolean>. */
  function confirm({ title = 'Подтверди', text, okLabel = 'Подтвердить', kind = 'primary' } = {}) {
    return new Promise(resolve => {
      let done = false;
      const m = modal({
        title,
        body: h('p', { text: text || '', style: { lineHeight: '1.6' } }),
        actions: [
          { label: 'Отмена', kind: 'ghost', onClick: () => { done = true; resolve(false); } },
          { label: okLabel, kind, onClick: () => { done = true; resolve(true); } },
        ],
        onClose: () => { if (!done) resolve(false); },
      });
      return m;
    });
  }

  /** Модалка с одним полем ввода. Возвращает Promise<string|null>. */
  function prompt({ title, label, value = '', placeholder = '', maxLength = 400, multiline = false } = {}) {
    return new Promise(resolve => {
      let done = false;
      const input = multiline
        ? h('textarea.textarea', { placeholder, maxlength: maxLength, rows: 4 }, value)
        : h('input.input', { type: 'text', placeholder, maxlength: maxLength, value });
      const wrap = h('div.field', [label ? h('label', { text: label }) : null, input]);
      const m = modal({
        title,
        body: wrap,
        actions: [
          { label: 'Отмена', kind: 'ghost', onClick: () => { done = true; resolve(null); } },
          { label: 'Готово', kind: 'primary', onClick: () => { done = true; resolve(input.value.trim()); } },
        ],
        onClose: () => { if (!done) resolve(null); },
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !multiline) {
          e.preventDefault();
          done = true;
          resolve(input.value.trim());
          m.close();
        }
      });
    });
  }

  window.ui = {
    h, $, $$, clear, append, dotaIcon, ago, plural, debounce, items,
    toast, ok, err, apiError, modal, closeModal, confirm, prompt,
  };
})();
