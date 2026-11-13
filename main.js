// Hstle desktop (Windows, macOS, Linux): apre il client web del tuo server in una finestra Chromium.
// Serve soprattutto a poter condividere lo schermo CON l'audio del computer, cosa che Firefox non permette.
const { app, BrowserWindow, Menu, session, desktopCapturer, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// Con un gioco a schermo intero la finestra di Hstle resta coperta: Chromium la considera "nascosta" e rallenta
// o ferma cattura e invio del video. Questi interruttori lo impediscono.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Linux: sotto Wayland lo schermo si cattura solo tramite PipeWire e il portale di sistema; senza questi
// interruttori Electron gira in XWayland e la condivisione resta nera o non parte.
// (--ozone-platform-hint invece non si può mettere da qui: Chromium lo legge prima che giri questo file, quindi
// l'app gira in XWayland; va bene lo stesso, perché la cattura passa comunque da PipeWire e dal portale.)
const IS_WAYLAND = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

/* Audio di una sola app (solo Windows): il pacchetto application-loopback lancia due piccoli programmi
   (ProcessList.exe e ApplicationLoopback.exe) che leggono l'audio del processo scelto. Se manca, resta
   solo l'opzione "tutto l'audio del computer". */
let loopback = null;
if (process.platform === 'win32') {
  try {
    loopback = require('application-loopback');
    loopback.setExecutablesRoot(path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'node_modules', 'application-loopback', 'bin'));
  } catch (e) { console.warn('audio per app non disponibile:', e.message); loopback = null; }
}

/* Cattura dell'audio per processo su tutti i sistemi: electron-native-screenshare (WASAPI su Windows,
   ScreenCaptureKit su macOS, PipeWire/PulseAudio su Linux). È opzionale: se non si carica, restano
   application-loopback (Windows) e l'audio di sistema di Chromium. */
let ens = null;
try {
  const mod = require('electron-native-screenshare');
  if (mod.isAvailable()) ens = mod; else console.warn('audio nativo non disponibile:', mod.getLoadError());
} catch (e) { console.warn('audio nativo non installato:', e.message); }

/* Linux: "tutto l'audio" senza le voci della chiamata (vedi linux-audio.js). */
const linuxAudio = process.platform === 'linux' ? require('./linux-audio') : null;
const ownPids = () => [process.pid, ...app.getAppMetrics().map((m) => m.pid)];
/** Su Linux prepara l'audio da condividere senza Hstle; se non ci riesce, niente audio (meglio che far sentire la chiamata). */
async function linuxSystemAudio() {
  try { await linuxAudio.start(ownPids); return true; }
  catch (e) { console.warn('[hstle] audio Linux non disponibile:', e.message); return false; }
}

const DEFAULT_URL = 'https://giuseppefausto.ddns.net:8444';
let win = null, picker = null, serverWin = null;
let pickerDone = null;
let pickerApps = new Map();
let pickerPids = new Map();   // id sorgente -> pid del programma che possiede la finestra
let capturePid = null;
let shareError = '';
let lastShare = null;      // ultima condivisione con audio di sistema: per riprovare senza audio se l'audio non parte      // perché l'ultima condivisione dello schermo non è partita (vuoto = annullata dalla persona)

const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function cleanUrl(s) {
  try {
    const u = new URL(String(s).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin + (u.pathname === '/' ? '' : u.pathname);
  } catch { return null; }
}
function serverUrl() {
  const arg = process.argv.find((a) => a.startsWith('--url='));
  const fromArg = arg && cleanUrl(arg.slice(6));
  if (fromArg) return fromArg;
  if (process.env.HSTLE_URL && cleanUrl(process.env.HSTLE_URL)) return cleanUrl(process.env.HSTLE_URL);
  try {
    const c = cleanUrl(JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).url);
    if (c) return c;
  } catch {}
  return DEFAULT_URL;
}
function saveUrl(u) {
  fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
  fs.writeFileSync(cfgFile(), JSON.stringify({ url: u }));
}
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const isOurs = (u) => originOf(u) === originOf(serverUrl());

function errorPage(url, msg) {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#08050f;color:#ece8f8;font:15px system-ui">
  <div style="max-width:420px;text-align:center"><h2>Non riesco a collegarmi</h2><p style="color:#8d82aa">${msg}<br>${url.replace(/</g, '')}</p>
  <p><button onclick="location.href='${url.replace(/'/g, '')}'" style="background:#8b5cf6;color:#fff;border:0;border-radius:10px;padding:10px 18px;font:inherit;cursor:pointer">Riprova</button></p>
  <p style="color:#8d82aa">Per cambiare indirizzo: menu Hstle → Cambia server.</p></div>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 380, minHeight: 500,
    backgroundColor: '#08050f', title: 'Hstle', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload-app.js'), backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  const url = serverUrl();
  win.loadURL(url);
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
    if (isMain && code !== -3) win.loadURL(errorPage(url, desc));
  });
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => {
    if (u.startsWith('data:') || isOurs(u)) return;
    e.preventDefault();
    if (/^https?:/.test(u)) shell.openExternal(u);
  });
  win.on('closed', () => { win = null; });
}

/* ---------- permessi: solo per il tuo server ---------- */
const OK_PERMS = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'notifications']);
function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(OK_PERMS.has(perm) && isOurs(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, perm, origin) => OK_PERMS.has(perm) && isOurs(origin));

  // Condivisione schermo: finestra di scelta nostra, e audio del computer.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    shareError = '';
    if (!isOurs(request.frame ? request.frame.url : '')) return callback({});
    // Seconda richiesta, solo video, subito dopo una con l'audio che non è partito: la pagina riprova senza audio.
    // Non riapriamo la finestra di scelta: riusiamo lo schermo scelto un attimo fa.
    const retry = !request.audioRequested && lastShare && Date.now() < lastShare.until ? lastShare : null;
    lastShare = null;
    if (retry && linuxAudio) linuxAudio.stop();
    if (retry && retry.video) { console.log('[hstle] riprovo senza audio:', retry.video.id); return callback({ video: retry.video }); }
    if (IS_WAYLAND) {            // Wayland: l'audio lo scegliamo noi, lo schermo lo sceglie il portale di sistema
      let audio = 'none';
      if (!retry) {
        const choice = await openPicker(true);
        if (!choice) return callback({});
        audio = choice.audio;
      }
      try {
        // anteprime piccole ma non nulle (come fa Signal): con 0x0 alcune versioni non avviano il flusso PipeWire
        const got = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 150, height: 150 }, fetchWindowIcons: false });
        console.log('[hstle] Wayland: sorgenti dal portale:', got.map((s) => s.id + ' ' + s.name), '| audio:', audio);
        if (!got.length) return callback({});     // il portale è stato chiuso senza scegliere
        const res = { video: got[0] };
        if (audio === 'system' && request.audioRequested && await linuxSystemAudio()) {
          res.audio = 'loopback';
          lastShare = { until: Date.now() + 10000 };   // se l'audio fallisce si ripassa dal portale, senza audio
        }
        return callback(res);
      } catch (e) {
        console.warn('condivisione Wayland:', e.message);
        shareError = 'il portale di sistema non ha dato lo schermo (' + e.message + '). Servono PipeWire e xdg-desktop-portal con il backend del tuo desktop (gnome, kde, wlr).';
        return callback({});
      }
    }
    const choice = await openPicker();
    if (!choice) return callback({});
    let sources = [];
    try { sources = await desktopCapturer.getSources({ types: ['screen', 'window'] }); }
    catch (e) { console.warn('elenco schermi:', e.message); shareError = 'non riesco a elencare gli schermi (' + e.message + ').'; return callback({}); }
    const video = sources.find((s) => s.id === choice.id);
    if (!video) { shareError = 'la sorgente scelta non esiste più: riprova.'; console.warn('[hstle] sorgente non trovata:', choice.id, sources.map((s) => s.id)); return callback({}); }
    console.log('[hstle] condivido', video.id, '| audio:', choice.audio);
    const res = { video };
    stopAppCapture();
    if (choice.audio === 'system' && request.audioRequested && (!linuxAudio || await linuxSystemAudio())) {
      res.audio = 'loopback';
      lastShare = { video, until: Date.now() + 10000 };
    }
    else if (choice.audio === 'app') startAppCapture(choice.pid || pickerPids.get(choice.id), true);   // l'audio arriva alla pagina da un altro percorso
    else if (choice.audio === 'except' && ens) startAppCapture(process.pid, false);                    // tutto l'audio tranne quello di Hstle
    callback(res);
  }, { useSystemPicker: false });
}

/* ---------- scelta di cosa condividere ---------- */
/** audioOnly: su Wayland si sceglie solo l'audio, lo schermo lo sceglie poi il portale di sistema. */
function openPicker(audioOnly = false) {
  return new Promise((resolve) => {
    if (picker) { picker.focus(); return resolve(null); }
    let settled = false;
    pickerDone = (v) => { if (!settled) { settled = true; resolve(v); } };
    picker = new BrowserWindow({
      width: audioOnly ? 620 : 760, height: audioOnly ? 200 : 560, useContentSize: audioOnly, parent: win || undefined, modal: !!win, title: 'Cosa vuoi condividere?',
      backgroundColor: '#130d20', autoHideMenuBar: true, minimizable: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
    });
    picker.setMenu(null);
    picker.loadFile(path.join(__dirname, 'picker.html'), audioOnly ? { query: { only: 'audio' } } : undefined);
    picker.on('closed', () => { picker = null; if (pickerDone) pickerDone(null); pickerDone = null; });
  });
}
/** Trova il programma a cui appartiene una finestra (per catturare solo il suo audio). */
async function pidForWindow(source, wins) {
  const m = /^window:(\d+):/.exec(source.id);
  const hw = m ? Number(m[1]) : NaN;
  const hit = wins.find((x) => { const h = String(x.hwnd).trim(); return parseInt(h, 10) === hw || parseInt(h.replace(/^0x/i, ''), 16) === hw; })
    || wins.find((x) => x.title && x.title === source.name);
  return hit ? String(hit.processId) : null;
}
ipcMain.handle('picker:sources', async (e) => {
  if (!picker || e.sender !== picker.webContents) return [];
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
  let wins = [];
  if (loopback) { try { wins = await loopback.getActiveWindowProcessIds(); } catch {} }
  pickerPids = new Map();
  const out = [];
  for (const s of list) {
    const screen = s.id.startsWith('screen:');
    let pid = !screen && wins.length ? await pidForWindow(s, wins) : null;
    if (!pid && !screen && ens) {                           // macOS e Linux (X11): il pacchetto nativo trova il programma dalla finestra
      const h = /^window:(\d+):/.exec(s.id);
      try { const p = h ? ens.getPidFromWindowHandle(Number(h[1])) : 0; if (p > 0) pid = String(p); } catch {}
    }
    if (pid && Number(pid) !== process.pid) pickerPids.set(s.id, pid);
    out.push({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), screen, app: pickerPids.has(s.id) });
  }
  // programmi con una finestra aperta: per lo schermo intero si può scegliere l'audio di uno solo (es. il gioco)
  pickerApps = new Map();
  for (const w of wins) {
    const pid = String(w.processId);
    if (Number(pid) === process.pid || !w.title || pickerApps.has(pid)) continue;
    pickerApps.set(pid, String(w.title).slice(0, 80));
  }
  return { sources: out, apps: [...pickerApps].map(([pid, title]) => ({ pid, title })) };
});
ipcMain.handle('picker:audio', () => (linuxAudio
  ? { linux: true, system: linuxAudio.available(), except: false, app: false }   // Linux: solo "tutto l'audio" (senza la chiamata) o niente
  : { system: ['win32', 'darwin'].includes(process.platform), except: !!ens, app: !!ens || !!loopback }));
ipcMain.on('picker:choose', (e, choice) => {
  if (!picker || e.sender !== picker.webContents) return;
  const done = pickerDone;
  pickerDone = null;
  if (done) done(choice && typeof choice.id === 'string' ? {
    id: choice.id,
    audio: ['app', 'except', 'system', 'none'].includes(choice.audio) ? choice.audio : 'none',
    pid: typeof choice.pid === 'string' && pickerApps.has(choice.pid) ? choice.pid : null,   // solo programmi dell'elenco mostrato
  } : null);
  picker.close();
});

/* ---------- audio di una sola app: dal programma alla pagina ---------- */
/** Porta l'audio ricevuto (float32 o 16 bit, qualsiasi frequenza) a 16 bit stereo a 48 kHz, il formato che la pagina si aspetta. */
function toS16Stereo48(data, meta) {
  const ch = Math.max(1, meta && meta.channels || 2), sr = (meta && meta.sampleRate) || 48000;
  const bits = (meta && meta.bitsPerSample) || 16, isFloat = !!(meta && meta.isFloat);
  if (!isFloat && bits === 16 && ch === 2 && sr === 48000) return data;
  const ab = new ArrayBuffer(data.length - (data.length % (bits / 8 * ch)));
  new Uint8Array(ab).set(data.subarray(0, ab.byteLength));       // copia allineata
  const src = isFloat && bits === 32 ? new Float32Array(ab) : bits === 16 ? new Int16Array(ab) : null;
  if (!src) return null;
  const scale = isFloat ? 32767 : 1, frames = (src.length / ch) | 0;
  const outFrames = sr === 48000 ? frames : Math.floor(frames * 48000 / sr);
  const out = new Int16Array(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const pos = sr === 48000 ? i : i * sr / 48000, i0 = pos | 0, i1 = Math.min(frames - 1, i0 + 1), fr = pos - i0;
    for (let c = 0; c < 2; c++) {
      const k = Math.min(c, ch - 1);
      const v = (src[i0 * ch + k] * (1 - fr) + src[i1 * ch + k] * fr) * scale;
      out[i * 2 + c] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
  }
  return Buffer.from(out.buffer);
}
let captureVia = null;
const sendAudio = (chunk) => { if (chunk && win && !win.isDestroyed()) win.webContents.send('app-audio', chunk); };
/** include = true: solo l'audio del programma `pid`; false: tutto tranne quello del programma `pid`. */
function startAppCapture(pid, include = true) {
  stopAppCapture();
  if (!pid) return false;
  if (ens) {
    try {
      ens.startCapture(Number(pid), include, (data, meta) => { try { sendAudio(toS16Stereo48(data, meta)); } catch {} });
      capturePid = String(pid); captureVia = 'ens';
      return true;
    } catch (e) { console.warn('cattura audio nativa:', e.message); }
  }
  if (include && loopback) {                                           // ripiego su Windows
    try {
      loopback.startAudioCapture(pid, { onData: sendAudio });
      capturePid = String(pid); captureVia = 'loopback';
      return true;
    } catch (e) { console.warn('cattura audio:', e.message); }
  }
  capturePid = null;
  return false;
}
function stopAppCapture() {
  if (capturePid) {
    try { if (captureVia === 'ens' && ens) ens.stopCapture(); else if (loopback) loopback.stopAudioCapture(capturePid); } catch {}
  }
  capturePid = null; captureVia = null;
  if (linuxAudio) linuxAudio.stop();
}
const fromMainWindow = (e) => win && e.sender === win.webContents && isOurs(e.senderFrame ? e.senderFrame.url : '');
ipcMain.handle('app-audio:active', (e) => fromMainWindow(e) && !!capturePid);
ipcMain.handle('app-audio:stop', (e) => { if (fromMainWindow(e)) stopAppCapture(); });
ipcMain.handle('share:error', (e) => { if (!fromMainWindow(e)) return ''; const s = shareError; shareError = ''; return s; });
app.on('before-quit', stopAppCapture);

/* ---------- cambiare server ---------- */
function openServerDialog() {
  if (serverWin) { serverWin.focus(); return; }
  serverWin = new BrowserWindow({
    width: 480, height: 260, parent: win || undefined, modal: !!win, title: 'Cambia server', resizable: false,
    backgroundColor: '#130d20', autoHideMenuBar: true, minimizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  serverWin.setMenu(null);
  serverWin.loadFile(path.join(__dirname, 'server.html'));
  serverWin.on('closed', () => { serverWin = null; });
}
ipcMain.handle('server:get', (e) => (serverWin && e.sender === serverWin.webContents ? serverUrl() : ''));
ipcMain.handle('server:set', (e, value) => {
  if (!serverWin || e.sender !== serverWin.webContents) return false;
  const u = cleanUrl(value);
  if (!u) return false;
  saveUrl(u);
  serverWin.close();
  if (win) win.loadURL(u);
  return true;
});

/* ---------- avvio ---------- */
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    if (linuxAudio && linuxAudio.available()) linuxAudio.cleanupLeftovers();   // uscite virtuali rimaste da un crash
    setupPermissions();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Hstle', submenu: [
        { label: 'Cambia server…', click: openServerDialog },
        { label: 'Ricarica', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.reload() },
        { label: 'Ricarica ignorando la cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => win && win.webContents.reloadIgnoringCache() },
        { label: 'Schermo intero', accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
        { label: 'Strumenti per sviluppatori', accelerator: 'CmdOrCtrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Esci', role: 'quit' },
      ] },
    ]));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
