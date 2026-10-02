/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — сборка backend
   ──────────────────────────────────────────────────────────────────────
   createBackend({ dataDir, host, port }) возвращает { app, db, listen }.
   В приложении сервер поднимается в главном процессе Electron и слушает
   только 127.0.0.1 на случайном порту; порт передаётся в renderer
   через preload, поэтому доступ извне закрыт по умолчанию.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cors = require('cors');

const { openDatabase, ensureFirstAdmin, userCount, getSetting, setSetting } = require('./db');
const { defaultDataDir, ensureDir, ROOT, MODES, TOP_KINDS, THREAD_CATEGORIES, TOP_TIERS, LIMITS, TALENT_LEVELS, lanAddresses, SHARE_PORT } = require('./config');
const { attachUser, initSecret, requireAdmin } = require('./auth');
const { cors: corsMw, jsonBody, rateLimit, wrap, notFoundHandler, errorMiddleware } = require('./http');
const { loadDataset } = require('./routes/catalog');
const { rosterOf } = require('./routes/rosters');

const authRoutes = require('./routes/auth');
const catalogRoutes = require('./routes/catalog');
const buildRoutes = require('./routes/builds');
const topRoutes = require('./routes/tops');
const threadRoutes = require('./routes/threads');
const guideRoutes = require('./routes/guides');
const userRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const reportRoutes = require('./routes/reports');
const rosterRoutes = require('./routes/rosters');
const mailer = require('./mailer');

const FIRST_ADMIN = { username: 'admin', password: 'dotacustoms' };

/**
 * Ростеры для клиента: ключи героев по режимам.
 * Отдаём вместе с конфигом, потому что выбор героя в редакторе билда
 * фильтруется по нему с первой загрузки окна — отдельный запрос означал бы
 * мигание списка при старте.
 */
function rosterSummaries(db, dataset) {
  const out = {};
  for (const m of MODES) out[m.key] = rosterOf(db, dataset, m.key).keys;
  return out;
}
function createBackend(opts = {}) {
  const isCloud = !!process.env.DATABASE_URL;
  const dataDir = opts.dataDir || defaultDataDir();
  if (!isCloud) ensureDir(dataDir);
  const db = openDatabase(dataDir);
  const dbFile = isCloud ? 'postgres' : path.join(dataDir, 'dotacustoms.db');
  const dataset = loadDataset();

  // Секрет подписи токенов читается из базы. Пока он был случайным на
  // каждый запуск процесса, любой перезапуск разлогинивал пользователя.
  const secretSource = initSecret(db);
  if (secretSource === 'created') {
    console.log('[dotacustoms] создан секрет подписи сессий — он сохранён в базе');
  }

  // Аварийный сид админа включается только через DOTACUSTOMS_SEED_ADMIN=1.
  // Обычно админом становится тот, кто первым зарегистрировался.
  const seededAdmin = ensureFirstAdmin(db, FIRST_ADMIN.username, FIRST_ADMIN.password);
  if (seededAdmin) {
    console.log(`[dotacustoms] создан аварийный админ: ${seededAdmin} / ${FIRST_ADMIN.password}`);
  } else if (userCount(db) === 0) {
    console.log('[dotacustoms] база пустая — зарегистрируйся, и твой аккаунт станет администратором');
  }

  // гайды подтягиваем из markdown-файлов (data/seed/guides/*.md)
  const { seedInto } = require('./seedGuides');
  const guideStats = seedInto(db);
  if (guideStats.added || guideStats.updated || guideStats.hidden) {
    console.log(`[dotacustoms] гайды: +${guideStats.added} новых, ${guideStats.updated} обновлено`);
  }

  const ctx = { db, dbFile, dataDir, dataset, seededAdmin, mailer };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(corsMw);
  app.use(jsonBody());
  app.use(attachUser(db));

  // ── служебные ────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => res.json({
    ok: true, service: 'dotacustoms', version: require('../package.json').version,
    patch: dataset.meta?.patch, db: path.basename(dbFile),
  }));

  // Сколько уровней талантов в текущем патче — берём из датасета, чтобы
  // редактор билда и бэкенд проверяли одно и то же число.
  const talentLevels = Array.isArray(dataset.meta?.talent_levels) && dataset.meta.talent_levels.length
    ? dataset.meta.talent_levels.map(Number)
    : TALENT_LEVELS;
  const limits = { ...LIMITS, maxTalents: talentLevels.length };
  ctx.limits = limits;
  ctx.talentLevels = talentLevels;


  app.get('/api/config', (_req, res) => res.json({
    modes: MODES,
    top_kinds: TOP_KINDS,
    thread_categories: THREAD_CATEGORIES,
    tiers: TOP_TIERS,
    talent_levels: talentLevels,
    limits,
    dataset: { patch: dataset.meta?.patch, built_at: dataset.meta?.built_at, counts: dataset.meta?.counts },
    rosters: rosterSummaries(db, dataset),
    mail: { configured: mailer.isConfigured(mailer.readConfig(db)) },
  }));

  // ── контентные ───────────────────────────────────────────────────────
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/catalog', catalogRoutes(ctx));
  app.use('/api/builds', buildRoutes(ctx));
  app.use('/api/tops', topRoutes(ctx));
  app.use('/api/threads', threadRoutes(ctx));
  app.use('/api/guides', guideRoutes(ctx));
  app.use('/api/users', userRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api/rosters', rosterRoutes(ctx));
  app.use('/api', reportRoutes(ctx));

  // ── общие ────────────────────────────────────────────────────────────
  app.get('/api/me', (req, res) => res.json({ user: req.user ? { id: req.user.id, role: req.user.role } : null }));
  app.get('/api/session', rateLimit({ windowMs: 60_000, max: 240 }), (req, res) => {
    res.json({ user: req.user ? { id: req.user.id, nickname: req.user.nickname, role: req.user.role } : null });
  });

  /* ── общий доступ по локальной сети ──────────────────────────────────
     Пользователь жаловался, что «нет базы, которая давала бы другим
     видеть билды». База одна — локальный файл. Поэтому тот, у кого
     включён общий доступ, отдаёт её по сети: остальные открывают ссылку
     в браузере и работают с той же базой, видят те же билды, топы и
     ветки, а свои добавляют туда же.

     Выключено по умолчанию: показывать свои данные всей сети без
     явного решения пользователя нельзя. */
  const shareState = {
    enabled: getSetting(db, 'share_enabled', '0') === '1',
  };

  /** Ссылки, по которым хаб доступен другим в сети. */
  function shareUrls() {
    return lanAddresses().map(ip => `http://${ip}:${ctx.port || SHARE_PORT}`);
  }

  function shareInfo() {
    // В облаке (DATABASE_URL) сайт живёт на Vercel — общий доступ к LAN
    // бессмыслен: слушать локальный порт в серверлесс-функции нельзя.
    if (isCloud) {
      return { enabled: false, port: 0, share_port: 0, urls: [], lan: [], hostname: 'vercel' };
    }
    return {
      enabled: shareState.enabled,
      port: ctx.port || 0,
      share_port: SHARE_PORT,
      urls: shareState.enabled ? shareUrls() : [],
      lan: lanAddresses(),
      hostname: require('os').hostname(),
    };
  }

  app.get('/api/share', (_req, res) => res.json(shareInfo()));

  app.post('/api/share', requireAdmin, wrap((req, res) => {
    const on = !!(req.body && req.body.enabled);
    shareState.enabled = on && !isCloud;
    setSetting(db, 'share_enabled', shareState.enabled ? '1' : '0');
    console.log(`[dotacustoms] общий доступ ${shareState.enabled ? 'ВКЛЮЧЁН' : 'выключен'}`);

    // Перевешиваем ПОСЛЕ ответа и не дожидаясь: close() ждёт завершения
    // текущих соединений, а текущее соединение — это и есть наш запрос.
    // Клиент переподключится сам: адрес сервера он узнаёт по требованию.
    if (!isCloud && typeof ctx.rebind === 'function') {
      setImmediate(() => {
        ctx.rebind(on).catch(err => console.error('[dotacustoms] не сменился адрес:', err.message));
      });
    }

    // Порта нового сервера ещё нет — сообщаем тот, что известен заранее.
    res.json({ ...shareInfo(), port: on ? SHARE_PORT : 0, pending: true });
  }));

  // Интерфейс для браузера: отдаём те же файлы, что и окно приложения,
  // иначе другие не смогут зайти по сети.
  app.use(express.static(path.join(ROOT, 'app'), {
    index: 'index.html',
    etag: true,
    maxAge: 0,
    setHeaders: res => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }));
  // Всё прочее (не /api и не файл) — на главную, чтобы работали ссылки вида
  // http://192.168.1.5:48711/#/builds и прямые заходы на разделы.
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(ROOT, 'app', 'index.html'));
  });

  app.use(notFoundHandler);
  app.use(errorMiddleware);

  let server = null;

  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server = app.listen(port, host, () => {
        ctx.port = server.address().port;
        ctx.host = server.address().address;
        resolve(server);
      });
      server.on('error', reject);
    });
  }

  /** Перевесить сервер на другой адрес/порт — при включении общего доступа. */
  async function rebind(enabled) {
    if (server) {
      const old = server;
      server = null;
      // close() сам по себе ждёт, пока закроются keep-alive соединения, а
      // браузер держит их открытыми — сервер не освободил бы порт никогда.
      // Поэтому сначала рвём соединения, и только потом ждём завершения.
      if (typeof old.closeAllConnections === 'function') old.closeAllConnections();
      await new Promise(resolve => old.close(resolve));
    }
    return enabled ? listen(SHARE_PORT, '0.0.0.0') : listen(0, '127.0.0.1');
  }
  ctx.rebind = rebind;

  function close() {
    if (server) {
      try { server.close(); } catch { /* уже закрыт */ }
      server = null;
    }
    try { db.close(); } catch { /* уже закрыта */ }
  }

  return {
    app, db, dbFile, dataDir, dataset, listen, rebind, close, ctx,
    shareInfo,
    get port() { return ctx.port || 0; },
    get host() { return ctx.host || '127.0.0.1'; },
  };
}

module.exports = { createBackend, FIRST_ADMIN };
