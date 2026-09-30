/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — preload
   ──────────────────────────────────────────────────────────────────────
   Единственный мост между renderer и главным процессом. Наружу торчат
   только базовый адрес локального сервера и несколько безобидных
   справочных функций — ни Node.js, ни файловой системы.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Порт приходит в адресе страницы: index.html грузится как
// file://…/app/index.html?port=54321
function readPort() {
  try {
    const fromQuery = new URL(window.location.href).searchParams.get('port');
    if (fromQuery && /^\d+$/.test(fromQuery)) return Number(fromQuery);
  } catch { /* не страшно — возьмём дефолт */ }
  return 0;
}

const port = readPort();

contextBridge.exposeInMainWorld('dotacustoms', {
  apiBase: port ? `http://127.0.0.1:${port}/api` : 'http://127.0.0.1:0/api',
  port,
  // Порт меняется, когда включается общий доступ по сети, поэтому
  // renderer спрашивает его по требованию, а не берёт из адреса страницы.
  currentPort: () => ipcRenderer.invoke('app:port'),
  info: () => ipcRenderer.invoke('app:info'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  platform: process.platform,
});
