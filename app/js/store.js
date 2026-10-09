/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — состояние приложения
   ──────────────────────────────────────────────────────────────────────
   Хранит справочник (герои/предметы/таланты), текущего пользователя и
   настройки интерфейса. Всё грузится один раз при старте, дальше экраны
   читают готовые структуры — поэтому поиск мгновенный и офлайновый.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h } = window.ui;

  const store = {
    ready: false,
    patch: '',
    cdn: '',
    config: { modes: [], top_kinds: [], thread_categories: [], tiers: [], limits: {} },
    me: null,
    session: null,

    // в базе пока нет ни одного пользователя — первый аккаунт станет админом
    firstRun: false,

    // справочник
    heroes: [],
    items: [],
    neutrals: [],
    abilities: [],

    // ростер героев кастомной игры: ключ -> id. Пусто = без ограничений.
    rosters: {},

    // кастомные предметы CHC — их нет в справочнике Valve
    customItems: [],
    customGroups: [],
    customSource: null,
    customRrSource: null,
    customPatch: null,
    customModes: null,
    customIdAliases: {},

    // быстрые индексы
    heroById: new Map(),
    heroByKey: new Map(),
    itemById: new Map(),
    neutralById: new Map(),
    abilityById: new Map(),
    itemByKey: new Map(),
    rosters: {},
    customById: new Map(),
    customByKey: new Map(),
    abilitiesByHero: new Map(),
    talentsByHero: new Map(),
    itemsByCategory: new Map(),
    neutralsByTier: new Map(),

    // пользовательские настройки
    prefs: {
      mode: 'chc',
      buildSort: 'new',
      itemQuality: 'all',
    },
  };

  /* ── локальные настройки ──────────────────────────────────────────── */
  const PREF_KEY = 'dc_prefs';

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (raw) Object.assign(store.prefs, JSON.parse(raw));
    } catch { /* повреждённые настройки — просто берём дефолт */ }
  }

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(store.prefs)); } catch { /* ок */ }
  }

  store.setPref = function (key, value) {
    store.prefs[key] = value;
    savePrefs();
    window.dispatchEvent(new CustomEvent('prefs-changed', { detail: { key, value } }));
  };

  /* ── хелперы по справочнику ───────────────────────────────────────── */
  // Уровни, на которых в кастоме берутся таланты. Их число зависит от
  // патча (в 7.41 у героя 8 талантов → 4 выбора), поэтому приходит
  // из /api/config; пока конфиг не загружен — консервативный дефолт.
  store.TALENT_LEVELS = [8, 10, 15, 20];

  function indexBy(list, key) {
    const m = new Map();
    for (const x of list) m.set(x[key], x);
    return m;
  }

  /** URL иконки в CDN Valve. */
  store.icon = function (img) {
    if (!img) return '';
    return `${store.cdn}/${img}`;
  };

  store.heroIcon = hero => store.icon(hero && hero.img);
  store.itemIcon = item => store.icon(item && item.img);
  store.neutralIcon = n => store.icon(n && n.img);
  store.abilityIcon = a => store.icon(a && a.img);
  store.customIcon = item => store.icon(item && item.img);

  /**
   * Ростер режима: массив КЛЮЧЕЙ героев («antimage») или null, если
   * ограничений нет. Приходит с сервера — из базы, а если там пусто,
   * то из data/custom/rosters.json.
   *
   * Именно ключи, а не id: id меняется при пересборке справочника, и
   * сохранённый ростер перестал бы совпадать с героями. Раньше здесь
   * стояло Number(), и любой заполненный ростер давал пустой список —
   * потому что Number('antimage') это NaN.
   */
  store.roster = function (mode) {
    const list = (store.config.rosters || store.rosters || {})[mode];
    if (!Array.isArray(list) || !list.length) return null;
    return list.map(String);
  };

  /**
   * Герои, доступные для выбора в режиме. В справочнике Dota их 127,
   * а в кастомной игре ростер меньше — лишних прячем, чтобы не тратить
   * время на прокрутку списка.
   */
  store.heroesFor = function (mode) {
    const keys = store.roster(mode);
    if (!keys) return store.heroes;
    const allow = new Set(keys);
    return store.heroes.filter(hero => allow.has(String(hero.key)));
  };

  /** Заголовок выбора героя: с ростером и без. */
  store.heroesTitle = function (mode) {
    const list = store.heroesFor(mode);
    return store.roster(mode)
      ? `Выбор героя — ${list.length} в игре`
      : `Выбор героя — ${list.length}`;
  };

  /**
   * Герой, которого нет в ростере режима. Так бывает, если ростер
   * пополнили, а билд или топ остались от прежнего состава. Молча
   * показывать его в списке нельзя — человек не поймёт, почему его
   * билд пропал из выдачи.
   */
  store.heroOutOfRoster = function (mode, heroId) {
    const keys = store.roster(mode);
    if (!keys || !heroId) return false;
    const hero = store.heroById.get(Number(heroId));
    return !!hero && !keys.includes(String(hero.key));
  };

  /**
   * Предмет по id — обычный или кастомный.
   * У кастомных id из диапазона 900000, так что пересечения быть не может,
   * но порядок поиска всё равно явный: сначала быстро обычный.
   *
   * Если id не нашёлся, пробуем таблицу старых id. До перехода на ключевые
   * id кастомные номера считались по индексу в каталоге, и добавление
   * предмета сдвигало все последующие: сохранённый билд молча превращался
   * в другой предмет. Таблица алиасов возвращает им прежнее значение.
   */
  store.anyItemById = function (id) {
    const n = Number(id);
    const found = store.itemById.get(n) || store.customById.get(n);
    if (found) return found;
    const key = store.customIdAliases[n];
    return key ? (store.customByKey.get(key) || null) : null;
  };

  /** Есть ли предмет в этом режиме. mode '*' — оба режима. */
  store.itemInMode = function (item, mode) {
    if (!item) return false;
    if (!mode) return true;
    const m = item.mode || '*';
    return m === '*' || m === mode;
  };

  /** Кастомные предметы, доступные в режиме. */
  store.customItemsFor = function (mode) {
    return store.customItems.filter(i => store.itemInMode(i, mode));
  };

  /** Кастомный предмет по ключу. */
  store.customItem = key => store.customByKey.get(key) || null;

  /**
   * Раскрывает связи кастомного предмета: на какие способности героев
   * он похож. Возвращает { abilities, items }, где способности уже
   * отфильтрованы — битых ключей в датасете быть не должно.
   */
  store.customRelations = function (item) {
    if (!item) return { abilities: [], items: [] };
    const abilities = (item.related_abilities || [])
      .map(k => store.abilities.find(a => a.key === k))
      .filter(Boolean);
    const items = (item.related_items || [])
      .map(k => store.itemByKey.get(k) || store.customByKey.get(k))
      .filter(Boolean);
    return { abilities, items };
  };

  /**
   * Боевые способности героя в порядке игры: только те, что реально
   * доступны в кастоме (herodata), без внутренних `antimage_ebb` и т.п.
   */
  store.heroAbilities = function (heroId) {
    const list = (store.abilitiesByHero.get(heroId) || []).filter(a => !a.is_talent);
    const real = list.filter(a => a.playable);
    const sorted = (real.length ? real : list).slice().sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    return sorted;
  };

  /**
   * Таланты героя, разложенные по уровням: [[8 → два варианта], [10 → …]].
   * Порядок берём из herodata, поэтому это ровно те варианты, которые
   * предлагает игра, а не угаданка по имени ключа.
   */
  store.heroTalents = function (heroId) {
    const list = (store.talentsByHero.get(heroId) || []).slice();
    const real = list.filter(t => t.playable);
    const sorted = (real.length ? real : list).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    const groups = store.TALENT_LEVELS.map(() => []);
    sorted.forEach((talent, i) => {
      groups[Math.min(groups.length - 1, Math.floor(i / 2))].push(talent);
    });
    return groups;
  };

  /** Режим по ключу. */
  store.mode = function (key) {
    return store.config.modes.find(m => m.key === key) || store.config.modes[0] || { key, title: key, short: key };
  };

  store.modeTitle = key => store.mode(key).title;
  store.modeShort = key => store.mode(key).short || store.mode(key).title;

  store.category = key => store.config.thread_categories.find(c => c.key === key) || null;

  store.limit = (name, fallback) => {
    const v = store.config.limits[name];
    return typeof v === 'number' ? v : fallback;
  };

  /* ── права ────────────────────────────────────────────────────────── */
  store.isAdmin = () => !!store.me && store.me.role === 'admin';
  store.isCoach = () => !!store.me && (store.me.role === 'coach' || store.me.role === 'admin');
  store.isStaff = () => store.isCoach();

  /** Coach может заниматься этим режимом? */
  store.coachesMode = function (mode) {
    if (!store.me) return false;
    if (store.me.role === 'admin') return true;
    if (store.me.role !== 'coach') return false;
    const scopes = store.me.coach_scopes || [];
    return scopes.includes('*') || scopes.includes(mode);
  };

  /* ── текущий пользователь ─────────────────────────────────────────── */
  store.setMe = function (payload) {
    store.me = payload && payload.user ? payload.user : null;
    if (store.me) {
      store.me.coach_scopes = (store.me.coach_scopes || []).map(String);
    }
  };

  /* ── загрузка при старте ──────────────────────────────────────────── */
  store.boot = async function () {
    loadPrefs();
    const [config, dataset] = await Promise.all([
      api.get('/config'),
      api.get('/catalog/dataset'),
    ]);
    if (!config.ok) throw new Error((config.data && config.data.error) || 'Сервер не отвечает');
    store.config = config.data;
    store.patch = config.data.dataset && config.data.dataset.patch;
    store.limits = config.data.limits;
    if (Array.isArray(config.data.talent_levels) && config.data.talent_levels.length) {
      store.TALENT_LEVELS = config.data.talent_levels.map(Number);
    }

    const d = dataset.data || {};
    store.cdn = (d.meta && d.meta.cdn) || 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
    store.heroes = d.heroes || [];
    store.items = d.items || [];
    store.neutrals = d.neutrals || [];
    store.abilities = d.abilities || [];

    // Ростер из справочника — запасной вариант. Основной приходит в
    // /api/config из базы (его можно править прямо в приложении),
    // а сюда попадает только если ростер задан файлом rosters.json.
    store.rosters = d.rosters || {};

    // Кастомные предметы CHC: у них нет id в справочнике Dota, поэтому
    // отдельный массив. Синтетические id начинаются с 900000 и не
    // пересекаются с настоящими предметами Valve.
    store.customItems = d.custom_items || [];
    store.customGroups = d.custom_groups || [];
    store.customSource = d.custom_source || null;
    store.customRrSource = d.custom_rr_source || null;
    store.customModes = d.custom_modes || null;
    store.customPatch = (d.meta && d.meta.custom_patch) || null;
    // старое (индексное) id → ключ: билды, созданные до перехода на
    // ключевые id, ссылаются на старые значения
    store.customIdAliases = d.custom_id_aliases || {};

    store.heroById = indexBy(store.heroes, 'id');
    store.heroByKey = indexBy(store.heroes, 'key');
    store.itemById = indexBy(store.items, 'id');
    store.itemByKey = indexBy(store.items, 'key');
    store.neutralById = indexBy(store.neutrals, 'id');
    store.abilityById = indexBy(store.abilities, 'id');
    store.customById = indexBy(store.customItems, 'id');
    store.customByKey = indexBy(store.customItems, 'key');

    store.abilitiesByHero = new Map();
    store.talentsByHero = new Map();
    for (const a of store.abilities) {
      if (!a.hero) continue;
      const hero = store.heroByKey.get(a.hero);
      if (!hero) continue;
      if (a.is_talent) {
        if (!store.talentsByHero.has(hero.id)) store.talentsByHero.set(hero.id, []);
        store.talentsByHero.get(hero.id).push(a);
      } else {
        if (!store.abilitiesByHero.has(hero.id)) store.abilitiesByHero.set(hero.id, []);
        store.abilitiesByHero.get(hero.id).push(a);
      }
    }

    store.itemsByCategory = new Map();
    for (const it of store.items) {
      const cat = it.category || 'other';
      if (!store.itemsByCategory.has(cat)) store.itemsByCategory.set(cat, []);
      store.itemsByCategory.get(cat).push(it);
    }

    store.neutralsByTier = new Map();
    for (const n of store.neutrals) {
      const t = n.tier || 1;
      if (!store.neutralsByTier.has(t)) store.neutralsByTier.set(t, []);
      store.neutralsByTier.get(t).push(n);
    }

    store.ready = true;
    return store;
  };

  /** Возвращает сохранённого пользователя, если токен ещё жив. */
  store.restoreSession = async function () {
    if (!api.getToken()) return null;
    const res = await api.get('/auth/me');
    if (res.ok && res.data && res.data.user) {
      store.setMe(res.data);
      return store.me;
    }
    api.setToken(null);
    store.setMe(null);
    return null;
  };

  /* ── частые сетевые вызовы с кэшем ───────────────────────────────── */
  const cache = new Map();

  store.cached = async function (key, loader, ttlMs) {
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < (ttlMs || 30_000)) return hit.value;
    const value = await loader();
    cache.set(key, { at: now, value });
    return value;
  };

  store.dropCache = function (prefix) {
    for (const k of Array.from(cache.keys())) {
      if (!prefix || k.startsWith(prefix)) cache.delete(k);
    }
  };

  window.store = store;
})();
