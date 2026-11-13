// Linux: "tutto l'audio" SENZA la chiamata.
// Chromium cattura l'uscita audio predefinita (il "monitor" del sink di default), che contiene anche le voci della
// chiamata. Per toglierle, durante la condivisione:
//   1. creiamo un'uscita virtuale "hstle_share" e la rimandiamo alle casse vere (così continui a sentire tutto);
//   2. la rendiamo l'uscita predefinita: Chromium cattura lei, e i programmi nuovi suonano lì;
//   3. spostiamo lì gli altri programmi, mentre l'audio di Hstle resta sulle casse vere e quindi non viene catturato.
// Funziona con PulseAudio e con PipeWire (pipewire-pulse): serve il comando `pactl`.
const { execFile, execFileSync, spawn } = require('child_process');
const path = require('path');

const SINK = 'hstle_share';
let state = null;   // { real, loopMod, nullMod, timer, ownPids }
let rec = null;     // il processo parec che registra l'uscita da condividere
const OWN_BIN = path.basename(process.execPath);   // "hstle" nell'app pacchettizzata, "electron" con npm start

function pactl(args) {
  return new Promise((resolve, reject) => execFile('pactl', args, { timeout: 4000 }, (e, out) => (e ? reject(e) : resolve(String(out)))));
}
function pactlSync(args) {
  try { return String(execFileSync('pactl', args, { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return ''; }
}

let avail = null;
function available() {
  if (avail === null) avail = process.platform === 'linux' && /Server Name/i.test(pactlSync(['info']));
  return avail;
}

async function defaultSinkName() {
  const m = /^Default Sink:\s*(.+)$/m.exec(await pactl(['info']));
  return m ? m[1].trim() : '';
}
async function sinks() {
  const byName = new Map();
  for (const line of (await pactl(['list', 'short', 'sinks'])).split('\n')) {
    const [idx, name] = line.split('\t');
    if (idx && name) byName.set(name, idx.trim());
  }
  return byName;
}
async function sinkInputs() {
  const out = await pactl(['list', 'sink-inputs']);
  const list = [];
  for (const block of out.split(/^Sink Input #/m).slice(1)) {
    const id = /^(\d+)/.exec(block);
    const sink = /^\s*Sink:\s*(\d+)/m.exec(block);
    const owner = /^\s*Owner Module:\s*(\S+)/m.exec(block);
    const pid = /application\.process\.id = "(\d+)"/.exec(block);
    const bin = /application\.process\.binary = "([^"]*)"/.exec(block);
    const name = /application\.name = "([^"]*)"/.exec(block);
    if (id && sink) list.push({ id: id[1], sink: sink[1], owner: owner ? owner[1] : '', pid: pid ? pid[1] : '', bin: bin ? bin[1] : '', name: name ? name[1] : '' });
  }
  return list;
}

/** Toglie moduli rimasti da una sessione precedente finita male (crash, kill). */
function cleanupLeftovers() {
  for (const line of pactlSync(['list', 'short', 'modules']).split('\n')) {
    const [idx, , args] = line.split('\t');
    if (idx && args && (args.includes('sink_name=' + SINK) || args.includes('source=' + SINK + '.monitor'))) pactlSync(['unload-module', idx.trim()]);
  }
}

/** Sposta i flussi: quelli di Hstle sulle casse vere, tutti gli altri (che erano sulle casse vere) nell'uscita da condividere. */
async function sync() {
  const st = state;
  if (!st) return;
  const own = new Set(st.ownPids().map(String));
  const byName = await sinks();
  const realIdx = byName.get(st.real), shareIdx = byName.get(SINK);
  if (!realIdx || !shareIdx) return;
  for (const si of await sinkInputs()) {
    if (si.owner === st.loopMod) continue;                   // il rimando alle casse
    // è di Hstle se viene da un nostro processo, o dal nostro eseguibile (i pid possono non coincidere, es. in una sandbox)
    const mine = (si.pid && own.has(si.pid)) || (si.bin && si.bin === OWN_BIN);
    const who = (si.name || '?') + ' [' + (si.bin || '?') + ' pid ' + (si.pid || '?') + ']';
    if (mine && si.sink !== realIdx) { console.log('[hstle] audio Linux: Hstle', who, '-> casse (non condiviso)'); await pactl(['move-sink-input', si.id, st.real]).catch((e) => console.warn('[hstle] spostamento fallito:', e.message)); }
    else if (!mine && si.sink === realIdx) { console.log('[hstle] audio Linux:', who, '-> condiviso'); await pactl(['move-sink-input', si.id, SINK]).catch((e) => console.warn('[hstle] spostamento fallito:', e.message)); }
  }
}

/** ownPids: funzione che restituisce i pid dei processi di Hstle (l'audio esce dal processo "audio service"). */
async function start(ownPids) {
  stop();
  cleanupLeftovers();
  const real = await defaultSinkName();
  if (!real || real === SINK) throw new Error('nessuna uscita audio predefinita');
  const nullMod = (await pactl(['load-module', 'module-null-sink', 'sink_name=' + SINK, 'sink_properties=device.description=Hstle-condivisione'])).trim();
  let loopMod = '';
  try {
    loopMod = (await pactl(['load-module', 'module-loopback', 'source=' + SINK + '.monitor', 'sink=' + real, 'latency_msec=30', 'source_dont_move=true', 'sink_dont_move=true'])).trim();
  } catch (e) { pactlSync(['unload-module', nullMod]); throw e; }
  state = { real, nullMod, loopMod, ownPids, timer: null };
  await pactl(['set-default-sink', SINK]);
  await sync();
  state.timer = setInterval(() => { sync().catch(() => {}); }, 700);   // programmi (o flussi di Hstle) nuovi
  console.log('[hstle] audio Linux: catturo tutto tranne Hstle (uscita vera:', real + ')');
}

/** Registra l'uscita da condividere e passa l'audio (16 bit, stereo, 48 kHz) a onData.
    Così non dipendiamo da quale uscita sceglie Chromium per il suo "loopback". */
function startCapture(onData) {
  stopCapture();
  if (!state) return false;
  try {
    const p = spawn('parec', ['-d', SINK + '.monitor', '--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=20', '--raw',
      '--client-name=Hstle-cattura', '--stream-name=condivisione'], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (b) => { try { onData(b); } catch {} });
    p.stderr.on('data', (b) => console.warn('[hstle] parec:', String(b).trim()));
    p.on('error', (e) => { console.warn('[hstle] parec non disponibile:', e.message); if (rec === p) rec = null; });
    p.on('exit', (c) => { if (rec === p) rec = null; if (c) console.warn('[hstle] parec uscito con codice', c); });
    rec = p;
    console.log('[hstle] audio Linux: registro', SINK + '.monitor');
    return true;
  } catch (e) { console.warn('[hstle] parec:', e.message); return false; }
}
function stopCapture() { if (rec) { try { rec.kill(); } catch {} rec = null; } }
function canRecord() { try { execFileSync('parec', ['--version'], { timeout: 2000, stdio: 'ignore' }); return true; } catch { return false; } }

/** Rimette tutto com'era. Sincrona, così funziona anche alla chiusura dell'app. */
function stop() {
  stopCapture();
  const st = state;
  if (!st) return;
  state = null;
  clearInterval(st.timer);
  pactlSync(['set-default-sink', st.real]);
  const byName = new Map(pactlSync(['list', 'short', 'sinks']).split('\n').map((l) => l.split('\t')).filter((p) => p[1]).map((p) => [p[1], p[0].trim()]));
  const shareIdx = byName.get(SINK);
  if (shareIdx) {
    for (const block of pactlSync(['list', 'sink-inputs']).split(/^Sink Input #/m).slice(1)) {
      const id = /^(\d+)/.exec(block), sink = /^\s*Sink:\s*(\d+)/m.exec(block);
      if (id && sink && sink[1] === shareIdx) pactlSync(['move-sink-input', id[1], st.real]);
    }
  }
  if (st.loopMod) pactlSync(['unload-module', st.loopMod]);
  pactlSync(['unload-module', st.nullMod]);
  console.log('[hstle] audio Linux: uscite ripristinate');
}

module.exports = { available, start, stop, cleanupLeftovers, startCapture, canRecord, active: () => !!state };
