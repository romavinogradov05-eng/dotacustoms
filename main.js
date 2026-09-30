/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — главный процесс Electron
   ──────────────────────────────────────────────────────────────────────
   Здесь поднимается локальный HTTP-сервер с базой и открывается окно.
   Сервер слушает только 127.0.0.1 на случайном порту; номер порта
   передаётся в renderer через preload, поэтому извне хаб не виден.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { createBackend } = require('./backend');

const HOST = '127.0.0.1';
let backend = null;
let mainWindow = null;

/** Иконка окна. В собранном приложении она лежит в resources. */
function appIcon() {
  const candidates = [
    path.join(__dirname, 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'build', 'icon.png'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0d0f14',
    autoHideMenuBar: true,
    show: false,
    // build/icon.png собирается из app/icon.jpg скриптом scripts/make-icon.js
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: !app.isPackaged,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  // Окно показываем только когда renderer готов — иначе пользователь
  // мелькает белым прямоугольником.
  win.once('ready-to-show', () => win.show());

  // Никаких новых окон и переходов наружу. Внутренняя навигация
  // (file://) разрешена, всё остальное открываем в системном браузере.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());

  // В собранном приложении прячем контекстное меню и devtools.
  if (app.isPackaged) {
    win.webContents.on('context-menu', event => event.preventDefault());
    win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());
  }

  win.loadFile('app/index.html', { query: { port: String(port) } });
  return win;
}

/** Открывает папку с базой в проводнике — для пользователя и для отладки. */
function openDataDir() {
  if (!backend) return { ok: false, error: 'Сервер не запущен' };
  shell.openPath(backend.dataDir);
  return { ok: true, path: backend.dataDir };
}

// Пишем лог рядом с программой: когда приложение падает при старте,
// окна ещё нет и пользователю некуда смотреть, кроме этого файла.
function startLog() {
  const dir = app.getPath('logs');
  const file = path.join(dir, 'dotacustoms.log');
  const stream = fs.createWriteStream(file, { flags: 'a' });
  const write = (level, args) => {
    const line = args
      .map(a => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : safe(a)))
      .join(' ');
    stream.write(`[${new Date().toISOString()}] ${level} ${line}\n`);
  };
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { original(...args); write(level.toUpperCase(), args); };
  }
  process.on('uncaughtException', err => {
    write('FATAL', [err]);
    try {
      dialog.showErrorBox('DotaCustoms', `Произошла ошибка:\n${err.message}\n\nПодробности: ${file}`);
    } catch { /* окно может быть ещё не готово */ }
  });
  console.log(`[dotacustoms] лог: ${file}`);
}

/** Структуру в консоль пишем без падения на циклах и Map. */
function safe(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  startLog();

  // Второй запуск того же приложения не должен лезть в ту же базу:
  // фокусируем уже открытое окно и выходим. Иначе SQLite ругается
  // «database is locked», и пользователь видит ошибку вместо окна.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  try {
    backend = createBackend();

    // Общий доступ по сети включается в настройках. Тогда сервер слушает
    // 0.0.0.0 на постоянном порту и другие заходят по обычному браузеру.
    // По умолчанию — только 127.0.0.1, чтобы данные не утекли случайно.
    const share = backend.shareInfo();
    const server = await backend.listen(
      share.enabled ? share.share_port : 0,
      share.enabled ? '0.0.0.0' : HOST,
    );
    const port = server.address().port;
    console.log(share.enabled
      ? `[dotacustoms] общий доступ: ${share.urls.join(', ') || `порт ${port}`}`
      : `[dotacustoms] сервер: http://${HOST}:${port}`);

    mainWindow = createWindow(port);

    server.on('error', err => {
      console.error('[dotacustoms] ошибка сервера:', err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox('DotaCustoms', `Локальный сервер упал:\n${err.message}`);
      }
    });
  } catch (err) {
    console.error('[dotacustoms] не удалось запустить сервер:', err);
    // диалог без окна выглядит как «программа не запустилась» — поэтому
    // показываем его только если окно ещё не создано, и всегда пишем в лог
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('DotaCustoms', `Локальный сервер упал:\n${err.message}`);
    } else {
      dialog.showErrorBox(
        'DotaCustoms — не удалось запустить',
        `${err.message}\n\nПодробности в файле dotacustoms.log рядом с программой.`,
      );
    }
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && backend) {
      mainWindow = createWindow(backend.port);
    }
  });
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  packaged: app.isPackaged,
  dataDir: backend ? backend.dataDir : null,
  dbFile: backend ? backend.dbFile : null,
}));

// Актуальный порт сервера. Меняется при включении общего доступа по сети,
// поэтому renderer спрашивает его по требованию, а не кэширует навсегда.
ipcMain.handle('app:port', () => (backend ? backend.port : 0));

ipcMain.handle('app:open-data-dir', () => openDataDir());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (backend) {
    try { backend.close(); } catch { /* уже закрыта */ }
  }
});

// Необработанные исключения в главном процессе. Обработчик ставим сразу,
// до app.whenReady(): если упадёт что-то при инициализации, пользователь
// должен узнать об этом, а не получить молчаливый отказ запуска.
process.on('uncaughtException', err => {
  console.error('[dotacustoms] необработанная ошибка:', err);
  try {
    const log = path.join(app.getPath('logs'), 'dotacustoms.log');
    dialog.showErrorBox('DotaCustoms', `Произошла ошибка:\n${err.message}\n\nПодробности: ${log}`);
  } catch { /* окно может быть ещё не готово */ }
});
