const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Discovery } = require('./src/discovery');
const { Streamer } = require('./src/streamer');
const { CastSession } = require('./src/cast');

// Zachytávanie nesmie spomaliť Chromium, keď je okno prekryté alebo minimalizované.
// AllowWgcScreenCapturer: zachytávanie cez Windows Graphics Capture pri videu na celú obrazovku
// dostáva len ~14 snímok/s, preto používame DXGI Desktop Duplication. Prepínač --wgc ho vráti.
const useWgc = process.argv.includes('--wgc');
app.commandLine.appendSwitch('disable-features', ['CalculateNativeWinOcclusion', ...(useWgc ? [] : ['AllowWgcScreenCapturer'])].join(','));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const INDEX_HTML = path.join(__dirname, 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;

let logFile = null;
function log(...parts) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${parts.join(' ')}\n`); } catch {}
}

let win = null;
let selectedSourceId = null;
let streamer = null;
let cast = null;
let active = false;

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// IPC prijímame len z našej vlastnej stránky
const trusted = (e) => !!e.senderFrame && e.senderFrame.url.startsWith(INDEX_URL);

const discovery = new Discovery((list) => send('devices:update', list));

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 700,
    minWidth: 420,
    minHeight: 520,
    title: `StreamPlay ${app.getVersion()}`,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required', // meranie hlasitosti zachyteného zvuku
      backgroundThrottling: false, // zachytávanie musí bežať aj pri minimalizovanom okne
    },
  });
  win.removeMenu();

  // Aplikácia nikdy nenačítava nič iné než vlastnú stránku
  win.on('page-title-updated', (e) => e.preventDefault()); // nech v titulku ostane číslo verzie
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  win.loadFile(INDEX_HTML);
  win.webContents.on('did-finish-load', () => {
    discovery.start();
    send('devices:update', discovery.list());
  });
}

async function teardown() {
  active = false;
  if (cast) { cast.onEnded = () => {}; cast.stop(); cast = null; }
  if (streamer) { streamer.removeAllListeners(); streamer.on('error', () => {}); await streamer.stop(); streamer = null; }
}

async function fail(message) {
  if (!active) return;
  await teardown();
  send('stream:ended', message);
}

async function listScreens() {
  return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  logFile = path.join(dataDir, 'last-run.log');
  // históriu posledných 8 spustení uchovávame v priečinku logs (na hľadanie chýb)
  try {
    const archive = path.join(dataDir, 'logs');
    fs.mkdirSync(archive, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 0) {
      const stamp = fs.statSync(logFile).mtime.toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(logFile, path.join(archive, `run-${stamp}.log`));
    }
    fs.readdirSync(archive).filter((f) => f.startsWith('run-')).sort().slice(0, -8)
      .forEach((f) => fs.rmSync(path.join(archive, f), { force: true }));
  } catch {}
  try { fs.writeFileSync(logFile, ''); } catch {}
  log('start, StreamPlay', app.getVersion(), 'electron', process.versions.electron, 'exe', process.execPath, 'capture', useWgc ? 'wgc' : 'dxgi');

  const ses = session.defaultSession;

  // Povolené je len zachytenie obrazovky/zvuku pre našu stránku, všetko ostatné zamietame
  const allowed = new Set(['display-capture', 'media']);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowed.has(permission) && (details.requestingUrl || '').startsWith(INDEX_URL));
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    return allowed.has(permission) && (details.requestingUrl || '').startsWith(INDEX_URL);
  });

  // Zachytenie vybranej obrazovky + zvuku systému (loopback) bez dialógu na výber
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!request.frame || !request.frame.url.startsWith(INDEX_URL)) return callback({});
      const sources = await listScreens();
      const src = sources.find((s) => s.id === selectedSourceId) || sources[0];
      // 'loopback' = zachytí zvuk systému nezávisle od hlasitosti PC (PC môže byť stlmený)
      callback({ video: src, audio: 'loopback' });
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });

  createWindow();
});

ipcMain.handle('sources:list', async (e) => {
  if (!trusted(e)) return [];
  const sources = await listScreens();
  return sources.map((s, i) => ({ id: s.id, name: s.name || `Obrazovka ${i + 1}` }));
});

ipcMain.handle('devices:rescan', (e) => { if (trusted(e)) discovery.rescan(); });

ipcMain.handle('stream:start', async (e, opts) => {
  if (!trusted(e)) throw new Error('Nepovolený odosielateľ');
  const { deviceId, sourceId } = opts || {};
  const height = 1080;
  const bitrate = Math.min(20, Math.max(1, Number(opts && opts.bitrate) || 5));
  const fps = 30;

  const device = typeof deviceId === 'string' ? discovery.get(deviceId) : null;
  if (!device) throw new Error('Zariadenie už nie je v sieti. Skús hľadanie znova.');
  await teardown();
  active = true;
  const screens = await listScreens();
  selectedSourceId = screens.some((s) => s.id === sourceId) ? sourceId : null;

  streamer = new Streamer();
  streamer.on('error', (err) => { log('streamer error:', err.message); fail(err.message); });
  streamer.on('log', (text) => log('ffmpeg:', text.trim().replace(/\s+/g, ' ')));
  streamer.on('http', (line) => log('http:', line));
  streamer.on('stats', (line) => log(line));
  const { url, encoder } = await streamer.start({ targetHost: device.host, height, bitrate, fps });
  log('stream start', device.name, device.host, encoder, height + 'p' + fps, bitrate + 'Mb/s',
    `hls ${streamer.hlsTime} s ${streamer.segExt}${streamer.markEvent ? ' EVENT' : ''}`);

  // renderer už môže začať zachytávať; medzitým pripravíme TV
  (async () => {
    try {
      send('stream:status', { state: 'preparing', text: `Pripravujem prúd (${encoder})…` });
      await streamer.waitReady();
      if (!active) return;
      log('playlist ready, casting');
      send('stream:status', { state: 'connecting', text: `Pripájam ${device.name}…` });
      cast = new CastSession();
      cast.onLog = (m) => log(m);
      cast.onEnded = (reason) => { log('cast ended:', reason); fail(reason); };
      await cast.play(device, url, { fmp4: streamer.fmp4 });
      if (!active) return;
      log('cast playing');

      // Ak si TV prúd nestiahla, takmer iste ju blokuje firewall na tomto PC
      for (let i = 0; i < 60 && active && streamer && !streamer.served; i++) await new Promise((r) => setTimeout(r, 250));
      if (!active) return;
      if (!streamer || !streamer.served) {
        log('TV nestiahla prúd, pravdepodobne firewall');
        send('firewall:hint');
        return fail('TV sa k tomuto PC nevie pripojiť, pravdepodobne ju blokuje firewall Windows.');
      }
      send('stream:status', { state: 'live', text: `Prenáša sa na ${device.name}`, encoder });
    } catch (err) {
      log('start failed:', err.stack || err.message || err);
      fail('Nepodarilo sa spustiť prenos: ' + (err.message || err));
    }
  })();

  return { ok: true, encoder };
});

ipcMain.on('log', (e, msg) => { if (trusted(e)) log('renderer:', String(msg).slice(0, 500)); });

ipcMain.on('stream:chunk', (e, data) => {
  if (!trusted(e) || !streamer || !active) return;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) streamer.write(Buffer.from(data.buffer || data, data.byteOffset, data.byteLength));
});

ipcMain.handle('stream:stop', async (e) => { if (trusted(e)) await teardown(); });

// Otvorí súbor s licenciami a upozorneniami o programoch tretích strán (napr. ffmpeg, GPL v3)
ipcMain.handle('licenses:open', (e) => {
  if (!trusted(e)) return;
  const base = app.isPackaged ? process.resourcesPath : __dirname;
  shell.openPath(path.join(base, 'THIRD-PARTY-NOTICES.txt'));
});

// Na žiadosť používateľa pridá pravidlo firewallu (Windows si vypýta potvrdenie správcu).
// Pravidlo je zúžené na TCP 8765 a lokálnu podsieť, a nie je viazané na cestu k programu,
// takže funguje aj pre portable verziu, ktorá sa pri každom spustení rozbalí inam.
ipcMain.handle('firewall:allow', (e) => {
  if (!trusted(e)) return false;
  const args = ['advfirewall', 'firewall', 'add', 'rule', 'name=StreamPlay8765', 'dir=in', 'action=allow',
    'protocol=TCP', 'localport=8765', 'remoteip=localsubnet', 'profile=any'];
  const ps = `Start-Process -FilePath netsh -Verb RunAs -WindowStyle Hidden -ArgumentList ${args.map((a) => `'${a}'`).join(',')}`;
  require('child_process').spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
  log('firewall rule requested');
  return true;
});

// Neočakávaná chyba nesmie ukázať systémový dialóg ani zhodiť aplikáciu
process.on('uncaughtException', (err) => { log('uncaught:', err && err.stack || err); fail('Neočakávaná chyba: ' + (err && err.message || err)); });
process.on('unhandledRejection', (err) => { log('unhandled rejection:', err && err.stack || err); fail('Neočakávaná chyba: ' + (err && err.message || err)); });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

app.on('before-quit', () => { discovery.stop(); teardown(); });
app.on('window-all-closed', () => { app.quit(); });
