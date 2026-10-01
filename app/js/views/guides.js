/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — обучение: список гайдов, страница гайда, редактор
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  const CATEGORY_RU = {
    basics: { title: 'Старт', icon: '🧭' },
    chc: { title: 'Custom Hero Chaos', icon: '🎲' },
    rr: { title: 'Ratten Run', icon: '🐀' },
    builds: { title: 'Билды', icon: '🧰' },
    rules: { title: 'Правила и ветки', icon: '📏' },
    other: { title: 'Прочее', icon: '📄' },
  };
  const cat = key => CATEGORY_RU[key] || CATEGORY_RU.other;

  /* ══════════════════════════════════════════════════════════════════
     Список
     ══════════════════════════════════════════════════════════════════ */
  async function renderList(host, _params, query) {
    clear(host);
    host.appendChild(h('div.page-head', [
      h('h1', { text: 'Обучение' }),
      h('div.sub', { text: 'Короткие руководства для новичков и разборы от Coach. Начни с «Старт».', }),
      store.isStaff() ? h('div.btn-row', h('a.btn.btn-primary', { href: '#/guides/new', text: '＋ Написать гайд' })) : null,
    ]));

    const tabs = h('div.tabs');
    const listHost = h('div');
    const active = query.category || '';

    function drawTabs() {
      clear(tabs);
      const options = [['', 'Все темы']].concat(Object.entries(CATEGORY_RU).filter(([k]) => k !== 'other').map(([k, v]) => [k, `${v.icon} ${v.title}`]));
      for (const [k, t] of options) {
        tabs.appendChild(h(`button.tab${active === k ? '.active' : ''}`, {
          type: 'button', text: t, onclick: () => router.go('/guides' + (k ? '?category=' + k : '')),
        }));
      }
    }
    drawTabs();
    host.appendChild(tabs);
    host.appendChild(listHost);

    listHost.appendChild(h('div.loading-panel', [h('div.spinner')]));
    const res = await api.get('/guides');
    clear(listHost);
    if (!res.ok) {
      listHost.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Гайды не загрузились' }));
      return;
    }
    const all = res.data.items || [];
    const items = active ? all.filter(g => g.category === active) : all;
    if (!items.length) {
      listHost.appendChild(common.empty({
        icon: '📘', title: 'В этой теме пусто',
        text: 'Напиши первый гайд — твой опыт может помочь другим.',
        action: store.isStaff() ? () => router.go('/guides/new') : null, actionLabel: 'Написать гайд',
      }));
      return;
    }

    // группировка по темам
    const byCat = new Map();
    for (const g of items) {
      if (!byCat.has(g.category)) byCat.set(g.category, []);
      byCat.get(g.category).push(g);
    }
    for (const [key, group] of byCat) {
      const c = cat(key);
      listHost.appendChild(h('h2.section-title', { text: `${c.icon} ${c.title}` }));
      const grid = h('div.grid.grid-2');
      for (const g of group) {
        grid.appendChild(h('a.card', { href: '#/guides/' + g.slug }, [
          h('div.meta-row', [
            g.is_official ? h('span.badge.badge-gold', { text: 'Официальный' }) : h('span.badge.badge-grey', { text: 'От игрока' }),
            h('span.spacer', { style: { flex: '1' } }),
            h('span', { text: g.ago }),
          ]),
          h('h3', { text: g.title }),
          g.summary ? h('div.excerpt', { text: g.summary }) : null,
        ]));
      }
      listHost.appendChild(grid);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     Страница гайда
     ══════════════════════════════════════════════════════════════════ */
  async function renderDetail(host, params) {
    clear(host);
    host.appendChild(h('div.loading-panel', [h('div.spinner')]));

    const res = await api.get('/guides/' + encodeURIComponent(params.slug));
    clear(host);
    if (!res.ok) {
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Гайд не найден' }),
        h('p', { text: (res.data && res.data.error) || 'Возможно, он удалён или ещё не опубликован' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/guides', text: '← Все гайды' })),
      ]));
      return;
    }
    const g = res.data.guide;
    const c = cat(g.category);

    host.appendChild(h('div.page-head', [
      h('div', [
        h('div.meta-row', [
          h('span.badge.badge-gold', { text: `${c.icon} ${c.title}` }),
          g.is_official ? h('span.badge.badge-green', { text: 'Официальный' }) : h('span.badge.badge-grey', { text: 'От игрока' }),
          h('span', { text: g.ago }),
        ]),
        h('h1', { text: g.title }),
        g.summary ? h('div.sub', { text: g.summary }) : null,
      ]),
      h('div.btn-row', [
        h('a.btn.btn-ghost', { href: '#/guides', text: '← Все гайды' }),
        g.can_edit ? h('a.btn', { href: '#/guides/' + g.slug + '/edit', text: '✎ Править' }) : null,
        g.can_edit ? h('button.btn.btn-danger', {
          type: 'button', text: 'Удалить',
          onclick: () => deleteGuide(g, () => router.go('/guides')),
        }) : null,
      ]),
    ]));

    const layout = h('div.build-layout');
    const main = h('div.panel', { html: md.render(g.body || '') });
    const side = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });

    /* оглавление */
    const toc = [];
    for (const line of String(g.body || '').split('\n')) {
      const m = /^(#{2,3})\s+(.*)$/.exec(line.trim());
      if (m) toc.push({ level: m[1].length, text: m[2].replace(/[*`]/g, '').trim() });
    }
    if (toc.length > 2) {
      const box = h('div.panel', [h('div.panel-title', [h('span', { text: '📑 Содержание' })])]);
      const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
      for (const t of toc) {
        list.appendChild(h('div', {
          style: { fontSize: '13px', color: 'var(--text-dim)', paddingLeft: (t.level - 2) * 12 + 'px' },
          text: t.text,
        }));
      }
      box.appendChild(list);
      side.appendChild(box);
    }

    if (g.author) {
      side.appendChild(h('div.panel', [
        h('div.panel-title', { text: 'Автор' }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, [
          auth.avatarNode(g.author, 'avatar-lg'),
          h('div', [
            h('a', { href: '#/u/' + encodeURIComponent(g.author.username), text: g.author.nickname,
              style: { fontWeight: '700', color: 'var(--text)', textDecoration: 'none' } }),
            h('div', { style: { fontSize: '12.5px', color: 'var(--text-mute)' }, text: '@' + g.author.username }),
          ]),
          auth.roleBadge(g.author),
        ]),
      ]));
    }

    layout.appendChild(main);
    layout.appendChild(side);
    host.appendChild(layout);
  }

  /* ══════════════════════════════════════════════════════════════════
     Редактор
     ══════════════════════════════════════════════════════════════════ */
  async function renderEditor(host, params) {
    if (!store.me) { router.go('/login'); ui.err('Сначала войди'); return; }
    clear(host);

    const isEdit = !!params.slug;
    if (!isEdit && !store.isStaff()) {
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Нет доступа' }),
        h('p', { text: 'Гайды пишут Coach и администраторы.' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/guides', text: '← К списку' })),
      ]));
      return;
    }
    let model = {
      slug: null, title: '', summary: '', body: '',
      category: 'basics', published: true,
    };

    if (isEdit) {
      host.appendChild(h('div.loading-panel', [h('div.spinner')]));
      const res = await api.get('/guides/' + encodeURIComponent(params.slug));
      clear(host);
      if (!res.ok) {
        host.appendChild(h('div.error-panel', [h('h3', { text: 'Гайд не найден' }), h('p', { text: (res.data && res.data.error) || '' })]));
        return;
      }
      const g = res.data.guide;
      if (!g.can_edit) {
        host.appendChild(h('div.error-panel', [h('h3', { text: 'Нет доступа' }), h('p', { text: 'Править гайд может автор, Coach или администратор.' })]));
        return;
      }
      Object.assign(model, { slug: g.slug, title: g.title, summary: g.summary || '', body: g.body || '', category: g.category, published: !!g.published });
    }

    host.appendChild(h('div.page-head', [
      h('div', [
        h('h1', { text: isEdit ? 'Правка гайда' : 'Новый гайд' }),
        h('div.sub', { text: 'Пиши по делу, с шагами и примерами. Markdown поддерживается.' }),
      ]),
      h('div.btn-row', [
        h('a.btn.btn-ghost', { href: isEdit ? '#/guides/' + model.slug : '#/guides', text: '← Отмена' }),
        h('button.btn.btn-primary', { type: 'button', text: '💾 Сохранить', onclick: save }),
      ]),
    ]));

    const titleInput = h('input.input', {
      type: 'text', maxlength: 120, value: model.title,
      placeholder: 'Например: «Как заходить за Крипсом в CHC»',
      oninput: e => { model.title = e.target.value; },
    });
    const summaryInput = h('input.input', {
      type: 'text', maxlength: 300, value: model.summary,
      placeholder: 'Одно предложение для списка гайдов',
      oninput: e => { model.summary = e.target.value; },
    });
    const catTabs = h('div.tabs');
    for (const [key, c] of Object.entries(CATEGORY_RU)) {
      catTabs.appendChild(h(`button.tab${model.category === key ? '.active' : ''}`, {
        type: 'button', text: `${c.icon} ${c.title}`,
        onclick: () => {
          model.category = key;
          for (const el of catTabs.querySelectorAll('.tab')) el.classList.remove('active');
          [...catTabs.children][[...Object.keys(CATEGORY_RU)].indexOf(key)].classList.add('active');
        },
      }));
    }

    const bodyArea = h('textarea.textarea', { style: { minHeight: '420px', fontFamily: 'Consolas, monospace', fontSize: '13.5px' } });
    bodyArea.value = model.body;
    bodyArea.addEventListener('input', () => { model.body = bodyArea.value; });

    const preview = h('div.md', { html: md.render(model.body) });
    const pubTrack = h('input', { type: 'checkbox' }); pubTrack.checked = model.published;
    pubTrack.addEventListener('change', () => { model.published = pubTrack.checked; });

    const layout = h('div.build-layout');
    const main = h('div.panel', [
      h('div.field', [h('label', { text: 'Название' }), titleInput]),
      h('div.field', [h('label', { text: 'Краткое описание' }), summaryInput]),
      h('div.field', [h('label', { text: 'Тема' }), catTabs]),
      h('div.field', [h('label', { text: 'Текст гайда (markdown)' }), bodyArea]),
      h('div.field', [h('label.switch', [pubTrack, h('span.track'), h('span.label', { text: 'Опубликован' })])]),
    ]);
    const side = h('div.panel', [
      h('div.panel-title', [h('span', { text: 'Предпросмотр' })]),
      preview,
    ]);

    bodyArea.addEventListener('input', window.ui.debounce(() => {
      preview.innerHTML = md.render(bodyArea.value);
    }, 400));

    layout.appendChild(main);
    layout.appendChild(side);
    host.appendChild(layout);

    async function save() {
      if (model.title.trim().length < 3) { ui.err('Название слишком короткое'); titleInput.focus(); return; }
      if (model.body.trim().length < 20) { ui.err('Текст гайда слишком короткий'); bodyArea.focus(); return; }
      const payload = {
        title: model.title.trim(), summary: model.summary.trim(),
        body: model.body, category: model.category, published: model.published,
      };
      let slug;
      if (isEdit) {
        const res = await api.patch('/guides/' + encodeURIComponent(model.slug), { body: payload });
        if (!res.ok) { ui.apiError(res, 'Гайд не сохранился'); return; }
        slug = model.slug;
      } else {
        const res = await api.post('/guides', { body: payload });
        if (!res.ok) { ui.apiError(res, 'Гайд не сохранился'); return; }
        slug = res.data.slug;
      }
      ui.ok(isEdit ? 'Гайд обновлён' : 'Гайд создан');
      router.go('/guides/' + slug);
    }
  }

  async function deleteGuide(g, onDone) {
    const yes = await ui.confirm({
      title: 'Удалить гайд?',
      text: `«${g.title}» исчезнет.`,
      okLabel: 'Удалить', kind: 'danger',
    });
    if (!yes) return;
    const res = await api.delete('/guides/' + encodeURIComponent(g.slug));
    if (!res.ok) { ui.apiError(res, 'Не удалось удалить'); return; }
    ui.ok('Гайд удалён');
    if (onDone) onDone();
  }

  window.views = window.views || {};
  window.views.guides = { renderList, renderDetail, renderEditor, deleteGuide, CATEGORY_RU };
})();
