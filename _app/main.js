/*
 * Soundboard Discord — processus principal Electron
 * Fenêtre, tray, raccourcis globaux, accès aux fichiers sons.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, globalShortcut, shell, protocol, net, nativeImage, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');

// Convertit un flux de lecture Node en ReadableStream Web (pour les Response de protocol.handle)
function streamToWeb(nodeStream) {
  if (typeof Readable.toWeb === 'function') return Readable.toWeb(nodeStream);
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (c) => controller.enqueue(new Uint8Array(c)));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (e) => controller.error(e));
    },
    cancel() { nodeStream.destroy(); },
  });
}

// Sert un fichier local avec support des requêtes Range (indispensable pour que
// <audio>/<video> puissent chercher/bufferiser sans repartir du début).
function serveFileWithRange(req, full, mime) {
  let stat;
  try { stat = fs.statSync(full); }
  catch { return new Response('not found', { status: 404 }); }
  const size = stat.size;
  const base = { 'Accept-Ranges': 'bytes', 'Content-Type': mime, 'Cache-Control': 'no-store' };
  const range = req.headers.get('Range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start === null) { start = Math.max(0, size - (end || 0)); end = size - 1; }
    else if (end === null || end >= size) end = size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
    }
    return new Response(streamToWeb(fs.createReadStream(full, { start, end })), {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(streamToWeb(fs.createReadStream(full)), {
    status: 200, headers: { ...base, 'Content-Length': String(size) },
  });
}

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm', '.aac', '.opus']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const STOP_ACCELERATOR = 'Ctrl+Alt+X';
const REPLAY_ACCELERATOR = 'Ctrl+Alt+R';
const OVERLAY_ACCELERATOR = 'Ctrl+Alt+O';

// ----- Câble audio virtuel (VB-Audio Virtual Cable) -----
// URL officielle du pack pilote (donationware, on télécharge, on ne redistribue pas).
const VBCABLE_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip';

// Exécute un petit script PowerShell et renvoie sa sortie (résolue en string).
function runPowerShell(script, { elevated = false } = {}) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const args = elevated
      // relance PowerShell élevé (UAC) exécutant le script encodé
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
         `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${b64}'`]
      : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64];
    const ps = spawn('powershell.exe', args, { windowsHide: true });
    let out = '', err = '';
    ps.stdout.on('data', (d) => out += d.toString());
    ps.stderr.on('data', (d) => err += d.toString());
    ps.on('error', reject);
    ps.on('exit', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// VB-Cable est-il installé ? (détecté via les périphériques PnP Windows)
async function cableInstalled() {
  if (process.platform !== 'win32') return true; // hors Windows : on ne bloque pas
  try {
    const { out } = await runPowerShell(
      "$d = Get-PnpDevice -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.FriendlyName -match 'CABLE (Input|Output)' -or $_.FriendlyName -match 'VB-Audio Virtual Cable' }; " +
      "if ($d) { 'YES' } else { 'NO' }");
    return /YES/.test(out);
  } catch { return false; }
}

// Télécharge + installe VB-Cable en silencieux (avec élévation UAC).
// Émet la progression via le callback onStep (affiché dans l'UI).
async function installCable(onStep) {
  const step = (m) => { try { onStep && onStep(m); } catch {} };
  const tmp = path.join(app.getPath('temp'), 'sb-vbcable');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });

    step('Téléchargement du câble audio…');
    const res = await net.fetch(VBCABLE_URL, { redirect: 'follow' });
    if (!res.ok) return { ok: false, error: 'Téléchargement impossible (HTTP ' + res.status + ')' };
    const zipPath = path.join(tmp, 'vbcable.zip');
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

    step('Décompression…');
    const ex = await runPowerShell(
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmp}' -Force`);
    if (ex.code !== 0) return { ok: false, error: 'Décompression échouée' };

    const setup = path.join(tmp, 'VBCABLE_Setup_x64.exe');
    if (!fs.existsSync(setup)) return { ok: false, error: 'Installateur introuvable dans l\'archive' };

    step('Installation du pilote (accepte la fenêtre Windows)…');
    // -i = install, -h = silencieux (flags documentés de VBCABLE_Setup)
    const inst = await runPowerShell(
      `$p = Start-Process -FilePath '${setup}' -ArgumentList '-i','-h' -Verb RunAs -Wait -PassThru; ` +
      `if ($p) { $p.ExitCode } else { 'NOPROC' }`);
    if (inst.code !== 0 && !/^\d+$/.test(inst.out)) {
      // l'utilisateur a probablement refusé l'UAC
      return { ok: false, error: 'Installation annulée ou refusée (fenêtre Windows).' };
    }

    step('Vérification…');
    // le périphérique peut mettre quelques secondes à apparaître
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      ok = await cableInstalled();
      if (!ok) await new Promise(r => setTimeout(r, 1500));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (ok) { step('Câble installé ✔'); return { ok: true, needsReboot: true }; }
    // installé mais pas encore visible : un redémarrage finalisera
    step('Pilote installé — un redémarrage est nécessaire.');
    return { ok: true, needsReboot: true, notYetVisible: true };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

// ----- Éditeur audio (ffmpeg pour la découpe/trim) -----
// Build statique win64 « essentials » (référence gyan.dev). Téléchargé une seule fois.
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
function ffmpegDir() { return path.join(app.getPath('userData'), 'ffmpeg'); }
function ffmpegPath() { return path.join(ffmpegDir(), 'ffmpeg.exe'); }
function ffmpegReady() { return fs.existsSync(ffmpegPath()); }

/* ---------- Modèle YAMNet (reconnaissance de sons, BÊTA) ---------- */
// Classifieur audio pré-entraîné (AudioSet, 521 classes). Téléchargé à la
// demande dans userData (~15 Mo). Plusieurs miroirs par sécurité.
function yamnetPath() { return path.join(app.getPath('userData'), 'yamnet', 'yamnet.onnx'); }
function yamnetReady() { try { return fs.statSync(yamnetPath()).size > 1_000_000; } catch { return false; } }
// Miroirs publics vérifiés du YAMNet ONNX (entrée « waveform » 1D, sortie [frames, 521]).
const YAMNET_MIRRORS = [
  'https://huggingface.co/jafet21/yamnetonnx/resolve/main/yamnet.onnx?download=true',
  'https://huggingface.co/zeropointnine/yamnet-onnx/resolve/main/yamnet.onnx?download=true',
  'https://huggingface.co/niobures/YAMNet/resolve/main/yamnetonnx/yamnet.onnx?download=true',
];

ipcMain.handle('yamnet-status', () => ({ ready: yamnetReady(), path: yamnetPath() }));

ipcMain.handle('yamnet-ensure', async () => {
  if (yamnetReady()) return { ok: true, already: true, path: yamnetPath() };
  const dir = path.dirname(yamnetPath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = yamnetPath() + '.part';
  let lastErr = '';
  for (const url of YAMNET_MIRRORS) {
    try {
      const res = await net.fetch(url, { redirect: 'follow' });
      if (!res.ok) { lastErr = 'HTTP ' + res.status; continue; }
      const reader = res.body.getReader();
      const ws = fs.createWriteStream(tmp);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!ws.write(Buffer.from(value))) await new Promise((r) => ws.once('drain', r));
        }
      } finally {
        await new Promise((r, j) => ws.end((e) => e ? j(e) : r()));
      }
      if (fs.statSync(tmp).size < 1_000_000) { fs.rmSync(tmp, { force: true }); lastErr = 'fichier trop petit'; continue; }
      fs.renameSync(tmp, yamnetPath());
      return { ok: true, path: yamnetPath() };
    } catch (e) {
      lastErr = String(e.message || e);
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  }
  return { ok: false, error: 'Aucun miroir disponible (' + lastErr + ')' };
});

// Renvoie le modèle en mémoire pour le charger dans le renderer (ort-web)
ipcMain.handle('yamnet-bytes', () => {
  try { return { ok: true, data: fs.readFileSync(yamnetPath()) }; }
  catch (e) { return { error: String(e.message || e) }; }
});

// Télécharge ffmpeg.exe (extrait du ZIP) dans userData. Progression via onStep.
async function ensureFfmpeg(onStep) {
  const step = (m) => { try { onStep && onStep(m); } catch {} };
  if (ffmpegReady()) return { ok: true, already: true };
  const tmp = path.join(app.getPath('temp'), 'sb-ffmpeg');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(ffmpegDir(), { recursive: true });

    step('Téléchargement de l\'outil de découpe (~30 Mo, une seule fois)…');
    const res = await net.fetch(FFMPEG_URL, { redirect: 'follow' });
    if (!res.ok) return { ok: false, error: 'Téléchargement impossible (HTTP ' + res.status + ')' };
    const zipPath = path.join(tmp, 'ffmpeg.zip');
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

    step('Décompression…');
    // extrait puis copie le seul ffmpeg.exe (dans .../bin/) vers ffmpegDir
    const ps = await runPowerShell(
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmp}' -Force; ` +
      `$exe = Get-ChildItem -Path '${tmp}' -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1; ` +
      `if ($exe) { Copy-Item $exe.FullName -Destination '${ffmpegPath()}' -Force; 'OK' } else { 'NOEXE' }`);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!ffmpegReady()) return { ok: false, error: 'ffmpeg.exe introuvable dans l\'archive' };
    step('Outil de découpe prêt ✔');
    return { ok: true };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

// Découpe un son entre start et end (secondes), avec fondus optionnels.
// opts: { start, end, fadeIn, fadeOut, replace, newName }
async function trimSound(file, opts = {}) {
  const src = safeJoin(file || '');
  if (!src || !fs.existsSync(src)) return { error: 'Fichier introuvable' };
  if (!ffmpegReady()) return { error: 'ffmpeg absent' };

  const start = Math.max(0, Number(opts.start) || 0);
  const end = Number(opts.end);
  if (!(end > start)) return { error: 'Sélection invalide' };
  const dur = end - start;
  const fadeIn = Math.max(0, Math.min(dur / 2, Number(opts.fadeIn) || 0));
  const fadeOut = Math.max(0, Math.min(dur / 2, Number(opts.fadeOut) || 0));
  const ext = path.extname(src);

  // fichier de sortie : remplacement (via temporaire) ou nouvelle copie
  const dir = path.dirname(src);
  let finalDest;
  if (opts.replace) {
    finalDest = src;
  } else {
    const base = sanitizeName(opts.newName || (path.basename(src, ext) + ' (découpé)')) || 'son';
    finalDest = uniquePath(dir, base, ext);
  }
  const tmpOut = path.join(dir, '~trim_' + Date.now() + ext);

  // -ss/-to placés APRÈS -i pour une découpe précise à l'échantillon
  // (avant -i, ffmpeg se cale sur la keyframe la plus proche -> début imprécis).
  const args = ['-y', '-i', src, '-ss', String(start), '-to', String(end)];
  const filters = [];
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  if (fadeOut > 0) filters.push(`afade=t=out:st=${(dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  if (filters.length) args.push('-af', filters.join(','));
  // ré-encodage MP3 haute qualité (V0 ~245 kbps VBR) : découpe exacte, perte négligeable.
  // Pour les formats non-MP3, ffmpeg choisit l'encodeur d'après l'extension de sortie.
  if (ext.toLowerCase() === '.mp3') args.push('-c:a', 'libmp3lame', '-q:a', '0');
  args.push(tmpOut);

  return await new Promise((resolve) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => err += d.toString());
    p.on('error', (e) => resolve({ error: String(e.message || e) }));
    p.on('exit', (code) => {
      if (code !== 0 || !fs.existsSync(tmpOut)) {
        try { fs.rmSync(tmpOut, { force: true }); } catch {}
        return resolve({ error: 'Découpe échouée' + (err ? ' : ' + err.split('\n').pop() : '') });
      }
      try {
        if (opts.replace) {
          fs.rmSync(finalDest, { force: true });
          fs.renameSync(tmpOut, finalDest);
        } else {
          fs.renameSync(tmpOut, finalDest);
        }
      } catch (e) {
        try { fs.rmSync(tmpOut, { force: true }); } catch {}
        return resolve({ error: String(e.message || e) });
      }
      resolve({ ok: true, file: path.relative(soundsDir(), finalDest).split(path.sep).join('/') });
    });
  });
}

// Normalisation du volume (EBU R128 loudnorm) : ramène le son à un niveau
// standard (-16 LUFS) pour que tous les sons de la bibliothèque sonnent
// aussi fort les uns que les autres. Remplace le fichier sur place.
async function normalizeSound(file) {
  const src = safeJoin(file || '');
  if (!src || !fs.existsSync(src)) return { error: 'Fichier introuvable' };
  if (!ffmpegReady()) return { error: 'ffmpeg absent' };

  const ext = path.extname(src);
  const dir = path.dirname(src);
  const tmpOut = path.join(dir, '~norm_' + Date.now() + ext);
  const args = ['-y', '-i', src, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'];
  if (ext.toLowerCase() === '.mp3') args.push('-c:a', 'libmp3lame', '-q:a', '0');
  args.push(tmpOut);

  return await new Promise((resolve) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => err += d.toString());
    p.on('error', (e) => resolve({ error: String(e.message || e) }));
    p.on('exit', (code) => {
      if (code !== 0 || !fs.existsSync(tmpOut)) {
        try { fs.rmSync(tmpOut, { force: true }); } catch {}
        return resolve({ error: 'Normalisation échouée' + (err ? ' : ' + err.split('\n').filter(Boolean).pop() : '') });
      }
      try {
        fs.rmSync(src, { force: true });
        fs.renameSync(tmpOut, src);
      } catch (e) {
        try { fs.rmSync(tmpOut, { force: true }); } catch {}
        return resolve({ error: String(e.message || e) });
      }
      resolve({ ok: true, file });
    });
  });
}

// ----- VCClient (moteur de voix IA temps réel, w-okada) -----
// Build CUDA (~3,5 Go) : embarque le moteur RVC -> lit les voix .pth (Macron,
// voix FR de voice-models.com/weights.gg…) ET Beatrice, en temps réel sur GPU.
// On utilise la 2.0.78-beta : la 2.1.4-alpha était livrée sans plusieurs DLL CUDA.
const VCCLIENT_URL = 'https://huggingface.co/wok000/vcclient000/resolve/main/vcclient_win_cuda_2.0.78-beta.zip?download=true';
// Port dédié (8080 est souvent pris par d'autres serveurs type Apache/httpd).
const VCCLIENT_PORT = 18888;
let vcclientProc = null;

function vcclientDir() { return path.join(app.getPath('userData'), 'vcclient'); }
function vcclientExe() { return path.join(vcclientDir(), 'dist', 'main', 'main.exe'); }
// Marqueur écrit UNIQUEMENT à la fin d'une install complète (download + extraction OK).
// Évite qu'une install interrompue (main.exe présent mais incomplet) soit vue comme prête.
function vcclientStamp() { return path.join(vcclientDir(), '.install_ok'); }
function vcclientReady() {
  return fs.existsSync(vcclientExe()) && fs.existsSync(vcclientStamp());
}
// La build CUDA (RVC) embarque onnxruntime GPU ; la build Beatrice-only non.
// On distingue les deux pour proposer la mise à niveau si besoin.
function vcclientHasRvc() {
  try {
    const internal = path.join(vcclientDir(), 'dist', 'main', '_internal');
    if (!fs.existsSync(internal)) return false;
    const hit = fs.readdirSync(internal).some(n => /onnxruntime/i.test(n))
      || fs.existsSync(path.join(internal, 'onnxruntime'))
      || fs.existsSync(path.join(internal, 'torch'));
    return hit;
  } catch { return false; }
}

// Télécharge + extrait VCClient. Progression via onStep.
async function installVcclient(onStep) {
  const step = (m) => { try { onStep && onStep(m); } catch {} };
  // Auto-réparation : une install complète mais sans marqueur (ex. installée par
  // une version antérieure de l'app) -> on pose le marqueur au lieu de re-télécharger.
  if (!fs.existsSync(vcclientStamp()) && fs.existsSync(vcclientExe()) && vcclientHasRvc()) {
    try { fs.writeFileSync(vcclientStamp(), 'healed ' + new Date().toISOString()); } catch {}
  }
  // déjà installé ET avec le moteur RVC -> rien à faire
  if (vcclientReady() && vcclientHasRvc()) return { ok: true, already: true };
  // ancienne build (Beatrice sans RVC) présente : on la remplace par la CUDA
  if (vcclientReady() && !vcclientHasRvc()) {
    step('Ancienne version détectée — remplacement par la version complète (RVC)…');
    stopVcclient();
    try { fs.rmSync(vcclientDir(), { recursive: true, force: true }); } catch {}
  }
  const tmp = path.join(app.getPath('temp'), 'sb-vcclient');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(vcclientDir(), { recursive: true });

    step('Téléchargement du moteur de voix IA (~3,5 Go, pour ton GPU — une seule fois)…');
    const res = await net.fetch(VCCLIENT_URL, { redirect: 'follow' });
    if (!res.ok) return { ok: false, error: 'Téléchargement impossible (HTTP ' + res.status + ')' };
    const total = Number(res.headers.get('content-length')) || 0;
    const zipPath = path.join(tmp, 'vcclient.zip');
    // Écriture en streaming DIRECTEMENT sur le disque (indispensable pour 3,5 Go :
    // accumuler en RAM dépasse la limite d'un ArrayBuffer JS ~2 Go -> crash).
    const reader = res.body.getReader();
    const ws = fs.createWriteStream(zipPath);
    let got = 0, lastPct = -1;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // applique la contre-pression : attend le drain si le buffer est plein
        if (!ws.write(Buffer.from(value))) {
          await new Promise((res2) => ws.once('drain', res2));
        }
        got += value.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) { step(`Téléchargement… ${pct}%`); lastPct = pct; }
        }
      }
    } finally {
      await new Promise((res2, rej2) => { ws.end((err) => err ? rej2(err) : res2()); });
    }

    step('Décompression (peut prendre plusieurs minutes pour 3,5 Go)…');
    // .NET ZipFile.ExtractToDirectory : plus fiable qu'Expand-Archive sur les
    // gros zips (Expand-Archive charge trop en mémoire et rame sur 3,5 Go).
    const ps = await runPowerShell(
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}', '${vcclientDir()}')`);
    fs.rmSync(tmp, { recursive: true, force: true });
    // vérifie l'extraction via l'exe + le moteur RVC (pas via vcclientReady qui exige le stamp)
    if (!fs.existsSync(vcclientExe()) || !vcclientHasRvc()) {
      return { ok: false, error: 'Décompression échouée' + (ps.err ? ' : ' + ps.err.split('\n')[0] : '') };
    }
    // marqueur de fin : à partir d'ici, l'install est considérée complète
    try { fs.writeFileSync(vcclientStamp(), new Date().toISOString()); } catch {}
    step('Moteur de voix IA installé ✔');
    return { ok: true };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

// Le serveur VCClient répond-il déjà sur le port ?
function vcclientResponding() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${VCCLIENT_PORT}/`, (res) => { res.destroy(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

// Lance VCClient (serveur local). Résout quand le port répond.
async function launchVcclient(onStep) {
  const step = (m) => { try { onStep && onStep(m); } catch {} };
  if (!vcclientReady()) return { ok: false, error: 'not-installed' };
  if (vcclientProc && !vcclientProc.killed) return { ok: true, already: true, url: `http://127.0.0.1:${VCCLIENT_PORT}/` };
  // déjà lancé par ailleurs (process résiduel qui tient le port) -> on le réutilise
  if (await vcclientResponding()) { step('Moteur déjà actif — réutilisation.'); return { ok: true, already: true, url: `http://127.0.0.1:${VCCLIENT_PORT}/` }; }
  try {
    // Commande réelle (cf. start_http.bat de la build 2.0.78) :
    //   main.exe cui --https false --no_cui True --port <PORT>
    vcclientProc = spawn(vcclientExe(),
      ['cui', '--https', 'false', '--no_cui', 'True', '--port', String(VCCLIENT_PORT)], {
      cwd: path.dirname(vcclientExe()),
      windowsHide: true,
      detached: false,
    });
    vcclientProc.on('exit', () => { vcclientProc = null; });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  // Au TOUT premier lancement, VCClient télécharge ses modèles auxiliaires
  // (hubert, rmvpe, contentvec…, plusieurs centaines de Mo) avant de répondre.
  // On attend donc longtemps (jusqu'à ~8 min) tant que le process vit.
  const url = `http://127.0.0.1:${VCCLIENT_PORT}/`;
  let warned = false;
  for (let i = 0; i < 480; i++) {           // 480 × 1 s = 8 min max
    await new Promise(r => setTimeout(r, 1000));
    if (!vcclientProc) return { ok: false, error: 'VCClient s\'est arrêté au démarrage.' };
    if (i === 12 && !warned) { warned = true; step('Premier lancement : téléchargement des modèles IA (quelques minutes)…'); }
    const up = await new Promise((resolve) => {
      const req = http.get(url, (res) => { res.destroy(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
    if (up) return { ok: true, url };
  }
  return { ok: false, error: 'VCClient n\'a pas répondu à temps (réessaie).', url };
}

function stopVcclient() {
  if (vcclientProc && !vcclientProc.killed) {
    try { vcclientProc.kill(); } catch {}
    vcclientProc = null;
  }
}

// ----- Backend Voix IA (RVC, Python) -----
const IA_PORT = 5273;
// Sources des scripts : _app/ia (dev) ou resources/ia (empaqueté)
const IA_SRC_DIR = app.isPackaged ? path.join(process.resourcesPath, 'ia') : path.join(__dirname, 'ia');
// En dev, on installe/tourne directement dans _app/ia. Empaqueté (portable),
// resources/ est éphémère -> dossier persistant. Si une installation existe déjà
// dans « <dossier des sons>/_app/ia » (dépôt cloné / installation précédente),
// on la réutilise pour éviter de re-télécharger plusieurs Go.
function iaDir() {
  if (!app.isPackaged) return IA_SRC_DIR;
  const repoDir = path.join(soundsDir(), '_app', 'ia');
  if (fs.existsSync(path.join(repoDir, '.venv310', 'Scripts', 'python.exe'))) return repoDir;
  return path.join(app.getPath('userData'), 'ia-backend');
}
function iaVenvPy() { return path.join(iaDir(), '.venv310', 'Scripts', 'python.exe'); }
let iaProc = null;          // process du serveur Python
let iaReady = false;        // le serveur a émis READY
let iaStarting = false;

// Copie les scripts IA vers le dossier de travail si besoin — appelé avant setup/lancement
function ensureIaScripts() {
  try {
    const dir = iaDir();
    if (path.normalize(dir) === path.normalize(IA_SRC_DIR)) return; // dev : déjà au bon endroit
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['server.py', 'requirements.txt', 'setup.ps1']) {
      const src = path.join(IA_SRC_DIR, f);
      const dst = path.join(dir, f);
      if (!fs.existsSync(src)) continue;
      // recopie si absent ou contenu différent (comparaison fiable, indépendante des dates)
      const data = fs.readFileSync(src);
      if (!fs.existsSync(dst) || !data.equals(fs.readFileSync(dst))) fs.writeFileSync(dst, data);
    }
  } catch (e) { /* best-effort */ }
}

let win = null;
let tray = null;
let watcher = null;
let config = {};

/* ---------- Config persistante ---------- */
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { config = {}; }
}
function saveConfig() {
  try { fs.writeFileSync(configPath(), JSON.stringify(config, null, 2)); } catch {}
}

function soundsDir() {
  const d = config.soundsDir || path.join(app.getPath('music'), 'SOUNDBOARD DISCORD');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

// Dossier des images d'icônes personnalisées (sous-dossier ignoré par le scan des sons)
function iconsDir() {
  const d = path.join(soundsDir(), '_icones');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

// Dossier des modèles de voix IA (défaut : « <dossier des sons>/Voix IA »)
function iaModelsDir() {
  return config.iaModelsDir || path.join(soundsDir(), 'Voix IA');
}

// Le dossier des modèles IA n'est pas une catégorie : interdit de le modifier via l'UI sons
function isProtectedFolder(folder) {
  const iaBase = path.relative(soundsDir(), iaModelsDir()).split(path.sep)[0];
  return String(folder || '').split('/')[0] === iaBase;
}

/* ---------- Backend Voix IA (Python RVC) ---------- */
function iaInstalled() {
  return fs.existsSync(iaVenvPy());
}

// Requête HTTP vers le serveur Python local
function iaHttp(method, pathname, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1', port: IA_PORT, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
        catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

// Démarre le serveur Python (à la demande). Résout quand READY.
function startIaBackend() {
  if (iaReady) return Promise.resolve({ ok: true, already: true });
  if (!iaInstalled()) return Promise.resolve({ ok: false, error: 'not-installed' });
  if (iaStarting) {
    // attend la fin du démarrage en cours
    return new Promise((resolve) => {
      const t = setInterval(() => {
        if (iaReady) { clearInterval(t); resolve({ ok: true }); }
        else if (!iaStarting) { clearInterval(t); resolve({ ok: false, error: 'start-failed' }); }
      }, 300);
    });
  }
  iaStarting = true;
  ensureIaScripts();
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; iaStarting = false; resolve(r); } };
    try {
      iaProc = spawn(iaVenvPy(), ['server.py', '--port', String(IA_PORT), '--models-dir', iaModelsDir()], {
        cwd: iaDir(),
        windowsHide: true,
      });
    } catch (e) {
      return done({ ok: false, error: String(e.message || e) });
    }
    const onData = (buf) => {
      const s = buf.toString();
      s.split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        if (win && !win.isDestroyed()) win.webContents.send('ia-log', line);
        if (line.includes('READY')) { iaReady = true; done({ ok: true }); }
      });
    };
    iaProc.stdout.on('data', onData);
    iaProc.stderr.on('data', onData);
    iaProc.on('exit', (code) => {
      iaReady = false; iaProc = null;
      if (win && !win.isDestroyed()) win.webContents.send('ia-log', `Backend arrêté (code ${code})`);
      done({ ok: false, error: 'exited' });
    });
    setTimeout(() => done({ ok: false, error: 'timeout' }), 60000);
  });
}

function stopIaBackend() {
  if (iaProc) {
    try { iaHttp('POST', '/live/stop', {}, 2000).catch(() => {}); } catch {}
    try { iaProc.kill(); } catch {}
    iaProc = null;
  }
  iaReady = false;
}

/* ---------- Scan des sons ---------- */
function listSounds() {
  const root = soundsDir();
  const iaBase = path.relative(root, iaModelsDir()).split(path.sep)[0];
  const out = [];
  (function scan(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('_') || e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (!rel && e.name === iaBase) continue; // dossier des modèles IA : pas des sons
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { scan(full, rel ? rel + '/' + e.name : e.name); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      out.push({
        name: path.basename(e.name, ext),
        file: (rel ? rel + '/' : '') + e.name,
        folder: rel || '',
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  })(root, '');
  out.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  return out;
}

function safeJoin(rel) {
  const root = soundsDir();
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  let i = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} (${i++})${ext}`);
  return candidate;
}

function importPaths(paths) {
  let ok = 0, fail = 0;
  const files = [];   // chemins relatifs des sons importés (pour normalisation, etc.)
  for (const p of paths || []) {
    try {
      const ext = path.extname(p).toLowerCase();
      if (!AUDIO_EXT.has(ext)) { fail++; continue; }
      const base = sanitizeName(path.basename(p, ext)) || 'son';
      const dest = uniquePath(soundsDir(), base, ext);
      fs.copyFileSync(p, dest);
      files.push(path.relative(soundsDir(), dest).split(path.sep).join('/'));
      ok++;
    } catch { fail++; }
  }
  return { ok, fail, files };
}

// Copie une image (chemin disque ou données data:) dans _icones/ et renvoie son nom de fichier
function saveIcon(sourcePathOrData, hintName) {
  try {
    let ext, buffer;
    if (typeof sourcePathOrData === 'string' && sourcePathOrData.startsWith('data:')) {
      const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/i.exec(sourcePathOrData);
      if (!m) return { error: 'Image invalide' };
      ext = '.' + m[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace('x-icon', 'ico');
      buffer = Buffer.from(m[2], 'base64');
    } else {
      ext = path.extname(sourcePathOrData).toLowerCase();
      if (!IMAGE_EXT.has(ext)) return { error: 'Format image non supporté' };
      buffer = fs.readFileSync(sourcePathOrData);
    }
    if (buffer.length > 8 * 1024 * 1024) return { error: 'Image trop lourde (max 8 Mo)' };
    const base = sanitizeName(hintName || 'icone') || 'icone';
    const dest = uniquePath(iconsDir(), base, ext);
    fs.writeFileSync(dest, buffer);
    return { ok: true, image: path.basename(dest) };
  } catch (e) { return { error: e.message }; }
}

// Supprime une image d'icône devenue inutile (best-effort)
function removeIcon(imageName) {
  if (!imageName) return;
  try {
    const full = path.join(iconsDir(), path.basename(imageName));
    if (full.startsWith(iconsDir() + path.sep) && fs.existsSync(full)) fs.unlinkSync(full);
  } catch {}
}

/* ---------- Surveillance du dossier ---------- */
function debounce(fn, ms) {
  let h;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}
function watchSounds() {
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  try {
    watcher = fs.watch(soundsDir(), { recursive: true }, debounce(() => {
      if (win && !win.isDestroyed()) win.webContents.send('sounds-changed');
    }, 400));
  } catch {}
}

/* ---------- Raccourcis globaux ---------- */
function registerHotkeys(map, enabled) {
  globalShortcut.unregisterAll();
  const registered = [], failed = [];
  if (enabled) {
    for (const acc of Object.keys(map || {})) {
      try {
        if (globalShortcut.register(acc, () => {
          if (win && !win.isDestroyed()) win.webContents.send('hotkey', acc);
        })) registered.push(acc);
        else failed.push(acc);
      } catch { failed.push(acc); }
    }
    try {
      globalShortcut.register(STOP_ACCELERATOR, () => {
        if (win && !win.isDestroyed()) win.webContents.send('stop-all');
      });
    } catch {}
    // instant replay : fige les dernières secondes (marche même hors focus)
    try {
      globalShortcut.register(REPLAY_ACCELERATOR, () => {
        if (win && !win.isDestroyed()) win.webContents.send('replay-save');
      });
    } catch {}
    // overlay in-game : affiche/cache la mini-fenêtre de favoris
    try {
      globalShortcut.register(OVERLAY_ACCELERATOR, () => toggleOverlay());
    } catch {}
  }
  return { registered, failed };
}

/* ---------- Overlay in-game (mini fenêtre de favoris) ---------- */
let overlayWin = null;

function toggleOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    if (overlayWin.isVisible()) { overlayWin.hide(); return; }
    overlayWin.showInactive();   // sans voler le focus au jeu
    overlayWin.webContents.send('overlay-refresh');
    return;
  }
  const b = config.overlayBounds || {};
  overlayWin = new BrowserWindow({
    width: b.width || 250,
    height: b.height || 400,
    x: b.x, y: b.y,
    minWidth: 180, minHeight: 220,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    backgroundColor: '#1e1f22',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  // au-dessus des jeux en fenêtré / borderless (pas du plein écran exclusif)
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.once('ready-to-show', () => overlayWin.showInactive());
  const saveBounds = () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    config.overlayBounds = overlayWin.getBounds();
    saveConfig();
  };
  overlayWin.on('moved', saveBounds);
  overlayWin.on('resized', saveBounds);
  overlayWin.on('closed', () => { overlayWin = null; });
}

ipcMain.handle('overlay-toggle', () => { toggleOverlay(); return { ok: true }; });
ipcMain.handle('overlay-close', () => { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide(); return { ok: true }; });
// l'overlay relaie la lecture à la fenêtre principale : volumes, stats et
// réglages (couper le précédent…) s'appliquent comme pour un clic normal
ipcMain.handle('overlay-play', (_e, file) => {
  if (win && !win.isDestroyed()) win.webContents.send('overlay-play', file);
  return { ok: true };
});
ipcMain.handle('overlay-stop', () => {
  if (win && !win.isDestroyed()) win.webContents.send('stop-all');
  return { ok: true };
});

/* ---------- Protocole snd:// (lecture des fichiers audio) ---------- */
protocol.registerSchemesAsPrivileged([
  { scheme: 'snd', privileges: { standard: true, stream: true, supportFetchAPI: true } },
  { scheme: 'icon', privileges: { standard: true, supportFetchAPI: true } },
  { scheme: 'vid', privileges: { standard: true, stream: true, supportFetchAPI: true } },
]);

/* ---------- Instance unique ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
}

/* ---------- Fenêtre & tray ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#313338',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      // permet d'embarquer l'interface de VCClient (voix IA) dans l'onglet Voix
      webviewTag: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // les liens externes (target=_blank) s'ouvrent dans le navigateur système,
  // pas dans une fenêtre Electron nue.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });
  // empêche toute navigation hors de l'app dans la fenêtre principale
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  win.on('close', (e) => {
    if (config.minimizeToTray !== false && !app.isQuitting) {
      e.preventDefault();
      win.hide();
      if (!config.trayNoticeShown) {
        config.trayNoticeShown = true;
        saveConfig();
        if (tray) tray.displayBalloon({
          title: 'Soundboard Discord',
          content: 'Le soundboard continue de tourner ici. Clic droit → Quitter pour l\'arrêter.',
          iconType: 'info',
        });
      }
    }
  });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip('Soundboard Discord');
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir le soundboard', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: '⏹ Stopper les sons', click: () => { if (win) win.webContents.send('stop-all'); } },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

/* ---------- IPC ---------- */
ipcMain.handle('list-sounds', () => listSounds());

/* ---------- Export / import de configuration (.soundboard) ---------- */
// Exporte sons + icônes + réglages partageables dans un fichier .soundboard (zip).
ipcMain.handle('export-config', async (_e, manifest) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Exporter ma bibliothèque',
    defaultPath: 'ma-bibliotheque.soundboard',
    filters: [{ name: 'Bibliothèque Soundboard', extensions: ['soundboard'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  const tmp = path.join(app.getPath('temp'), 'sb-export-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });
    // manifest des réglages partageables (favoris, icônes, raccourcis, volumes…)
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest || {}, null, 2));
    // copie tous les sons (en gardant l'arborescence des catégories)
    const soundsRoot = soundsDir();
    for (const s of listSounds()) {
      const src = safeJoin(s.file);
      if (!src || !fs.existsSync(src)) continue;
      const dst = path.join(tmp, 'sounds', s.file.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    // copie les images d'icônes
    const ic = iconsDir();
    if (fs.existsSync(ic)) {
      const dstIc = path.join(tmp, '_icones');
      fs.mkdirSync(dstIc, { recursive: true });
      for (const f of fs.readdirSync(ic)) {
        try { fs.copyFileSync(path.join(ic, f), path.join(dstIc, f)); } catch {}
      }
    }
    // zippe le tout (System.IO.Compression), puis renomme en .soundboard
    const zipTmp = path.join(app.getPath('temp'), 'sb-export-' + Date.now() + '.zip');
    const ps = await runPowerShell(
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::CreateFromDirectory('${tmp}', '${zipTmp}')`);
    if (ps.code !== 0 || !fs.existsSync(zipTmp)) return { ok: false, error: 'Échec de la compression' };
    fs.rmSync(r.filePath, { force: true });
    fs.renameSync(zipTmp, r.filePath);
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: true, file: r.filePath };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
});

// Importe un .soundboard : ajoute ses sons/icônes et renvoie son manifest.
ipcMain.handle('import-config', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Importer une bibliothèque',
    properties: ['openFile'],
    filters: [{ name: 'Bibliothèque Soundboard', extensions: ['soundboard', 'zip'] }],
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  const tmp = path.join(app.getPath('temp'), 'sb-import-' + Date.now());
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const ps = await runPowerShell(
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${r.filePaths[0]}', '${tmp}')`);
    if (ps.code !== 0) return { ok: false, error: 'Fichier illisible' };

    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')); } catch {}

    // copie les sons dans le dossier (sans écraser : uniquePath), en notant les remaps
    const remap = {};   // ancien chemin -> nouveau chemin (pour recaler icônes/favs)
    let added = 0;
    const srcSounds = path.join(tmp, 'sounds');
    if (fs.existsSync(srcSounds)) {
      (function walk(dir, rel) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          const relPath = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) { walk(full, relPath); continue; }
          const ext = path.extname(e.name).toLowerCase();
          if (!AUDIO_EXT.has(ext)) continue;
          const folder = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
          const destDir = folder ? safeJoin(folder) : soundsDir();
          if (!destDir) continue;
          fs.mkdirSync(destDir, { recursive: true });
          const dest = uniquePath(destDir, path.basename(e.name, ext), ext);
          fs.copyFileSync(full, dest);
          remap[relPath] = path.relative(soundsDir(), dest).split(path.sep).join('/');
          added++;
        }
      })(srcSounds, '');
    }
    // copie les icônes
    const srcIc = path.join(tmp, '_icones');
    if (fs.existsSync(srcIc)) {
      const dstIc = iconsDir();
      for (const f of fs.readdirSync(srcIc)) {
        try { if (!fs.existsSync(path.join(dstIc, f))) fs.copyFileSync(path.join(srcIc, f), path.join(dstIc, f)); } catch {}
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: true, added, manifest, remap };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
});

// Enregistre un clip audio (instant replay) : buffer WAV -> nouveau son.
// Dossier (catégorie) des enregistrements de l'instant replay.
const RECORDINGS_FOLDER = 'Enregistrements';
function recordingsDir() {
  const d = path.join(soundsDir(), RECORDINGS_FOLDER);
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

ipcMain.handle('save-clip', (_e, wavBuffer, name) => {
  try {
    // nom horodaté par défaut (ex. « Replay 14h32m07 »), rangé dans « Enregistrements »
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dflt = `Replay ${pad(t.getHours())}h${pad(t.getMinutes())}m${pad(t.getSeconds())}`;
    const base = sanitizeName(name && name !== 'Replay' ? name : dflt) || 'clip';
    const dest = uniquePath(recordingsDir(), base, '.wav');
    fs.writeFileSync(dest, Buffer.from(wavBuffer));
    // chemin relatif complet (catégorie/fichier) pour l'affichage
    return { ok: true, file: path.relative(soundsDir(), dest).split(path.sep).join('/') };
  } catch (e) { return { error: String(e.message || e) }; }
});

// Enregistre un clip VIDÉO (replay ShadowPlay) dans « Clips vidéo » (userData).
// Les .webm ne sont pas des sons -> catégorie à part, hors de la bibliothèque de sons.
function videoClipsDir() {
  const d = path.join(app.getPath('userData'), 'clips-video');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
ipcMain.handle('save-video-clip', (_e, buffer, name) => {
  try {
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dflt = `Clip ${pad(t.getHours())}h${pad(t.getMinutes())}m${pad(t.getSeconds())}`;
    const base = sanitizeName(name || dflt) || 'clip';
    const dest = uniquePath(videoClipsDir(), base, '.webm');
    fs.writeFileSync(dest, Buffer.from(buffer));
    return { ok: true, file: path.basename(dest), path: dest };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('list-video-clips', () => {
  try {
    const dir = videoClipsDir();
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.webm'))
      .map((f) => { const st = fs.statSync(path.join(dir, f)); return { file: f, mtime: st.mtimeMs, size: st.size }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
});
ipcMain.handle('delete-video-clip', (_e, file) => {
  try {
    const full = path.join(videoClipsDir(), path.basename(file));
    if (full.startsWith(videoClipsDir()) && fs.existsSync(full)) fs.rmSync(full, { force: true });
    return { ok: true };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('open-video-clip', (_e, file) => {
  const full = path.join(videoClipsDir(), path.basename(file));
  if (fs.existsSync(full)) shell.showItemInFolder(full);
  return { ok: true };
});
ipcMain.handle('reveal-video-clips', () => { shell.openPath(videoClipsDir()); return { ok: true }; });

/* ---------- IPC TTS (texte -> voix, moteur Edge gratuit) ---------- */
// Synthétise le texte et renvoie le MP3 en mémoire ; la lecture (câble +
// casque) reste côté renderer, comme pour n'importe quel son.
ipcMain.handle('tts-speak', async (_e, text, opts = {}) => {
  try {
    const t = String(text || '').trim().slice(0, 1000);
    if (!t) return { error: 'Texte vide' };
    const { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } = require('msedge-tts');
    const tts = new MsEdgeTTS();
    await tts.setMetadata(opts.voice || 'fr-FR-DeniseNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const prosody = new ProsodyOptions();
    prosody.rate = Math.min(2, Math.max(0.5, Number(opts.rate) || 1));
    const pitch = Math.min(50, Math.max(-50, Number(opts.pitch) || 0));
    prosody.pitch = (pitch >= 0 ? '+' : '') + pitch + 'Hz';
    const { audioStream } = await tts.toStream(t, prosody);
    const data = await new Promise((resolve, reject) => {
      const chunks = [];
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', () => resolve(Buffer.concat(chunks)));
      audioStream.on('error', reject);
    });
    if (!data.length) return { error: 'Synthèse vide (réessaie)' };
    return { ok: true, data };
  } catch (e) {
    const m = String(e.message || e);
    return { error: /ENOTFOUND|ECONN|network|socket/i.test(m) ? 'Pas de connexion internet' : m };
  }
});

// Garde la dernière phrase synthétisée comme un vrai son (catégorie « TTS »)
ipcMain.handle('tts-save', (_e, audioBuffer, name, ext) => {
  try {
    const dir = path.join(soundsDir(), 'TTS');
    fs.mkdirSync(dir, { recursive: true });
    const base = sanitizeName(String(name || '').slice(0, 40)) || 'phrase';
    const safeExt = ext === 'wav' ? '.wav' : '.mp3';
    const dest = uniquePath(dir, base, safeExt);
    fs.writeFileSync(dest, Buffer.from(audioBuffer));
    return { ok: true, file: path.relative(soundsDir(), dest).split(path.sep).join('/') };
  } catch (e) { return { error: String(e.message || e) }; }
});

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Ajouter des sons',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm', 'aac', 'opus'] }],
  });
  if (r.canceled) return { ok: 0, fail: 0 };
  return importPaths(r.filePaths);
});

ipcMain.handle('import-files', (_e, paths) => importPaths(paths));

// Télécharge un son depuis une URL http(s) directe (ex. myinstants)
ipcMain.handle('import-url', async (_e, url) => {
  try {
    const u = new URL(String(url || '').trim());
    if (!/^https?:$/.test(u.protocol)) return { error: 'URL invalide (http/https uniquement)' };
    const res = await net.fetch(u.toString(), { redirect: 'follow' });
    if (!res.ok) return { error: 'Téléchargement échoué (HTTP ' + res.status + ')' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { error: 'Fichier vide' };
    if (buf.length > 100 * 1024 * 1024) return { error: 'Fichier trop volumineux (max 100 Mo)' };
    let base = decodeURIComponent(u.pathname.split('/').pop() || '') || 'son';
    let ext = path.extname(base).toLowerCase();
    if (!AUDIO_EXT.has(ext)) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      ext = ct.includes('mpeg') || ct.includes('mp3') ? '.mp3'
        : ct.includes('wav') ? '.wav'
        : ct.includes('ogg') || ct.includes('opus') ? '.ogg'
        : ct.includes('mp4') || ct.includes('m4a') || ct.includes('aac') ? '.m4a'
        : ct.includes('flac') ? '.flac' : '';
      if (!ext) return { error: 'Le lien ne pointe pas vers un fichier audio' };
    }
    const nameNoExt = sanitizeName(path.basename(base, path.extname(base))) || 'son';
    const dest = uniquePath(soundsDir(), nameNoExt, ext);
    fs.writeFileSync(dest, buf);
    return { ok: true, file: path.basename(dest) };
  } catch (e) { return { error: String(e.message || e) }; }
});

ipcMain.handle('rename', (_e, file, newName) => {
  const full = safeJoin(file || '');
  if (!full || !fs.existsSync(full)) return { error: 'Fichier introuvable' };
  const base = sanitizeName(newName || '');
  if (!base) return { error: 'Nom invalide' };
  const ext = path.extname(full);
  const dest = uniquePath(path.dirname(full), base, ext);
  try { fs.renameSync(full, dest); } catch (e) { return { error: e.message }; }
  return { ok: true, file: path.relative(soundsDir(), dest).split(path.sep).join('/') };
});

ipcMain.handle('remove', (_e, file) => {
  const full = safeJoin(file || '');
  if (!full || !fs.existsSync(full)) return { error: 'Fichier introuvable' };
  const trash = path.join(soundsDir(), '_corbeille');
  try {
    fs.mkdirSync(trash, { recursive: true });
    const ext = path.extname(full);
    fs.renameSync(full, uniquePath(trash, path.basename(full, ext), ext));
  } catch (e) { return { error: e.message }; }
  return { ok: true };
});

/* ---------- Catégories (sous-dossiers du dossier des sons) ---------- */
// Dossiers de premier niveau (hors techniques _xxx / cachés / modèles IA)
ipcMain.handle('list-folders', () => {
  try {
    // le dossier des modèles IA vit dans le dossier des sons : ce n'est pas une catégorie
    const iaBase = path.relative(soundsDir(), iaModelsDir()).split(path.sep)[0];
    return fs.readdirSync(soundsDir(), { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')
        && e.name !== 'node_modules' && e.name !== iaBase)
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  } catch { return []; }
});

ipcMain.handle('create-folder', (_e, name) => {
  const base = sanitizeName(name || '');
  if (!base || base.startsWith('_') || base.startsWith('.')) return { error: 'Nom invalide' };
  const full = safeJoin(base);
  if (!full) return { error: 'Nom invalide' };
  if (fs.existsSync(full)) return { error: 'Cette catégorie existe déjà' };
  try { fs.mkdirSync(full, { recursive: true }); } catch (e) { return { error: e.message }; }
  return { ok: true, folder: base };
});

ipcMain.handle('rename-folder', (_e, folder, newName) => {
  if (isProtectedFolder(folder)) return { error: 'Ce dossier est réservé aux voix IA' };
  const src = safeJoin(folder || '');
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { error: 'Catégorie introuvable' };
  const base = sanitizeName(newName || '');
  if (!base || base.startsWith('_') || base.startsWith('.')) return { error: 'Nom invalide' };
  const dst = path.join(path.dirname(src), base);
  if (fs.existsSync(dst)) return { error: 'Une catégorie porte déjà ce nom' };
  try { fs.renameSync(src, dst); } catch (e) { return { error: e.message }; }
  return { ok: true, folder: path.relative(soundsDir(), dst).split(path.sep).join('/') };
});

// Supprime une catégorie : tout son contenu part dans _corbeille (rien n'est perdu)
ipcMain.handle('delete-folder', (_e, folder) => {
  if (isProtectedFolder(folder)) return { error: 'Ce dossier est réservé aux voix IA' };
  const src = safeJoin(folder || '');
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { error: 'Catégorie introuvable' };
  const trash = path.join(soundsDir(), '_corbeille');
  try {
    fs.mkdirSync(trash, { recursive: true });
    let dst = path.join(trash, path.basename(src));
    let i = 2;
    while (fs.existsSync(dst)) dst = path.join(trash, `${path.basename(src)} (${i++})`);
    fs.renameSync(src, dst);
  } catch (e) { return { error: e.message }; }
  return { ok: true };
});

// Déplace un son vers une autre catégorie ('' = racine / Général)
ipcMain.handle('move-sound', (_e, file, targetFolder) => {
  if (isProtectedFolder(targetFolder)) return { error: 'Ce dossier est réservé aux voix IA' };
  const src = safeJoin(file || '');
  if (!src || !fs.existsSync(src)) return { error: 'Fichier introuvable' };
  const folder = String(targetFolder || '').trim();
  const destDir = folder ? safeJoin(folder) : soundsDir();
  if (!destDir) return { error: 'Catégorie invalide' };
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const ext = path.extname(src);
    const dest = uniquePath(destDir, path.basename(src, ext), ext);
    fs.renameSync(src, dest);
    return { ok: true, file: path.relative(soundsDir(), dest).split(path.sep).join('/') };
  } catch (e) { return { error: e.message }; }
});

// Choisir une image via l'explorateur pour l'icône d'un son
ipcMain.handle('pick-icon', async (_e, hintName) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir une image pour ce son',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  return saveIcon(r.filePaths[0], hintName);
});

// Enregistrer une image depuis un chemin (glisser-déposer) ou des données data:
ipcMain.handle('save-icon', (_e, source, hintName) => saveIcon(source, hintName));

// Supprimer une image d'icône devenue inutile
ipcMain.handle('remove-icon', (_e, imageName) => { removeIcon(imageName); return { ok: true }; });

ipcMain.handle('get-info', () => ({
  soundsDir: soundsDir(),
  version: app.getVersion(),
  minimizeToTray: config.minimizeToTray !== false,
  openAtLogin: app.getLoginItemSettings().openAtLogin,
  stopAccelerator: STOP_ACCELERATOR,
  iaInstalled: iaInstalled(),
  iaModelsDir: iaModelsDir(),
}));

/* ---------- IPC Câble audio virtuel ---------- */
ipcMain.handle('cable-status', async () => ({ installed: await cableInstalled() }));

ipcMain.handle('cable-install', async () => {
  const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send('cable-log', m); };
  return await installCable(send);
});

ipcMain.handle('cable-reboot', () => {
  // redémarrage dans 3 s, laisse le temps de fermer proprement
  runPowerShell('shutdown /r /t 3 /c "Redemarrage pour finaliser le cable audio"');
  return { ok: true };
});

/* ---------- IPC VCClient (voix IA temps réel) ---------- */
ipcMain.handle('vcclient-status', async () => ({
  installed: vcclientReady(),
  hasRvc: vcclientReady() && vcclientHasRvc(),   // true = build CUDA (voix RVC .pth)
  // "en marche" = notre processus OU un serveur déjà lancé qui répond sur le port
  running: !!(vcclientProc && !vcclientProc.killed) || await vcclientResponding(),
  url: `http://127.0.0.1:${VCCLIENT_PORT}/`,
}));

ipcMain.handle('vcclient-install', async () => {
  const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send('vcclient-log', m); };
  return await installVcclient(send);
});

ipcMain.handle('vcclient-launch', async () => {
  const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send('vcclient-log', m); };
  send('Démarrage du moteur de voix IA…');
  const r = await launchVcclient(send);
  if (r.ok) send('Moteur prêt — la fenêtre va s\'ouvrir.');
  return r;
});

ipcMain.handle('vcclient-open-ui', () => {
  shell.openExternal(`http://127.0.0.1:${VCCLIENT_PORT}/`);
  return { ok: true };
});

ipcMain.handle('vcclient-stop', () => { stopVcclient(); return { ok: true }; });

// Convertit un audio (float32 mono) avec la voix IA courante du moteur.
// Utilisé par l'onglet « Dire » : TTS -> voix de Macron/JDG/… Renvoie du PCM
// int16 mono au même sample rate.
ipcMain.handle('vcclient-convert', async (_e, f32buf, opts = {}) => {
  try {
    const base = `http://127.0.0.1:${VCCLIENT_PORT}`;
    const sr = Number(opts.sampleRate) || 48000;
    // configure le slot de voix et les sample rates du flux
    let res = await net.fetch(base + '/api/configuration-manager/configuration');
    if (!res.ok) return { error: 'Moteur de voix IA injoignable' };
    const cfg = await res.json();
    if (opts.slot != null) cfg.current_slot_index = Number(opts.slot);
    cfg.input_sample_rate = sr;
    cfg.output_sample_rate = sr;
    res = await net.fetch(base + '/api/configuration-manager/configuration', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
    });
    if (!res.ok) return { error: 'Configuration refusée (HTTP ' + res.status + ')' };
    // envoi du waveform en multipart (format qu'attend convert_chunk)
    const boundary = 'sbtts' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="waveform"; filename="waveform.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from(f32buf),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    res = await net.fetch(base + '/api/voice-changer/convert_chunk', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!res.ok) {
      const t = (await res.text()).slice(0, 200);
      return { error: 'Conversion échouée (HTTP ' + res.status + ') ' + t };
    }
    return { ok: true, data: Buffer.from(await res.arrayBuffer()), sampleRate: sr };
  } catch (e) { return { error: String(e.message || e) }; }
});

// Proxy générique vers l'API REST de VCClient (évite CORS/CSP côté renderer).
// Seuls les chemins /api/ du serveur local sont autorisés.
ipcMain.handle('vcclient-api', async (_e, apiPath, method = 'GET', body = null) => {
  try {
    if (!/^\/api\//.test(String(apiPath))) return { error: 'Chemin non autorisé' };
    const res = await net.fetch(`http://127.0.0.1:${VCCLIENT_PORT}${apiPath}`, {
      method,
      headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status}`, detail: text.slice(0, 300) };
    try { return { ok: true, data: JSON.parse(text) }; }
    catch { return { ok: true, data: null }; }
  } catch (e) { return { error: String(e.message || e) }; }
});

/* ---------- IPC Éditeur audio (découpe) ---------- */
ipcMain.handle('editor-status', () => ({ ready: ffmpegReady() }));

ipcMain.handle('editor-ensure', async () => {
  const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send('editor-log', m); };
  return await ensureFfmpeg(send);
});

ipcMain.handle('editor-trim', async (_e, file, opts) => trimSound(file, opts));

ipcMain.handle('editor-normalize', async (_e, file) => normalizeSound(file));

/* ---------- IPC Voix IA ---------- */
ipcMain.handle('ia-status', async () => {
  const base = { installed: iaInstalled(), running: iaReady, modelsDir: iaModelsDir() };
  if (!iaReady) return base;
  try { return { ...base, ...(await iaHttp('GET', '/health')) }; }
  catch { return { ...base, running: false }; }
});

ipcMain.handle('ia-start', async () => {
  const r = await startIaBackend();
  return r;
});

ipcMain.handle('ia-stop', () => { stopIaBackend(); return { ok: true }; });

ipcMain.handle('ia-models', async () => {
  const s = await startIaBackend();
  if (!s.ok) return { ok: false, error: s.error, models: [] };
  try { return { ok: true, ...(await iaHttp('GET', '/models')) }; }
  catch (e) { return { ok: false, error: String(e.message || e), models: [] }; }
});

ipcMain.handle('ia-select', async (_e, name) => {
  const s = await startIaBackend();
  if (!s.ok) return { ok: false, error: s.error };
  try { return await iaHttp('POST', '/select', { name }, 120000); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('ia-params', async (_e, params) => {
  if (!iaReady) return { ok: false, error: 'backend arrêté' };
  try { return await iaHttp('POST', '/params', params); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('ia-live-start', async (_e, opts) => {
  const s = await startIaBackend();
  if (!s.ok) return { ok: false, error: s.error };
  try { return await iaHttp('POST', '/live/start', opts || {}, 120000); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('ia-live-stop', async () => {
  if (!iaReady) return { ok: true };
  try { return await iaHttp('POST', '/live/stop', {}); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Retour casque du live IA (on/off + volume), sans redémarrer le live
ipcMain.handle('ia-live-monitor', async (_e, opts) => {
  if (!iaReady) return { ok: false, error: 'backend arrêté' };
  try { return await iaHttp('POST', '/live/monitor', opts || {}); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Niveaux entrée/sortie du live (vu-mètres de l'UI)
ipcMain.handle('ia-live-level', async () => {
  if (!iaReady) return { live: false, rms: 0, in_rms: 0 };
  try { return await iaHttp('GET', '/live/level', null, 3000); }
  catch { return { live: false, rms: 0, in_rms: 0 }; }
});

ipcMain.handle('ia-devices', async () => {
  const s = await startIaBackend();
  if (!s.ok) return { ok: false, error: s.error };
  try { return { ok: true, ...(await iaHttp('GET', '/devices')) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Installe le backend (venv + deps) en lançant setup.ps1, progression via ia-log
ipcMain.handle('ia-setup', () => {
  ensureIaScripts();
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', path.join(iaDir(), 'setup.ps1')],
      { cwd: iaDir(), windowsHide: true });
    let failed = false;
    const onData = (buf) => {
      buf.toString().split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        const msg = line.startsWith('SETUP:') ? line.slice(6) : line;
        if (win && !win.isDestroyed()) win.webContents.send('ia-log', msg);
        if (/ERREUR|ERROR/i.test(line)) failed = true;
      });
    };
    ps.stdout.on('data', onData);
    ps.stderr.on('data', onData);
    ps.on('exit', (code) => resolve({ ok: code === 0 && !failed && iaInstalled(), code }));
    ps.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
  });
});

ipcMain.handle('choose-sounds-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir le dossier des sons',
    defaultPath: soundsDir(),
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  config.soundsDir = r.filePaths[0];
  saveConfig();
  watchSounds();
  return soundsDir();
});

ipcMain.handle('open-sounds-folder', () => shell.openPath(soundsDir()));

ipcMain.handle('set-global-hotkeys', (_e, map, enabled) => registerHotkeys(map, enabled));

ipcMain.handle('set-open-at-login', (_e, v) => {
  app.setLoginItemSettings({ openAtLogin: !!v });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('set-minimize-to-tray', (_e, v) => {
  config.minimizeToTray = !!v;
  saveConfig();
  return config.minimizeToTray;
});

/* ---------- Cycle de vie ---------- */
app.whenReady().then(() => {
  app.setAppUserModelId('com.wistee.soundboard-discord');
  loadConfig();

  // Autorise micro / énumération des périphériques sans popup
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });

  // Capture du son système (WASAPI loopback) pour l'instant replay « ce que j'entends »,
  // sans avoir besoin du Mixage stéréo. getDisplayMedia({audio:'loopback'}) côté renderer
  // passe par ce handler ; on renvoie une source écran mais on ne garde que l'audio.
  try {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      }).catch(() => callback({}));
    }, { useSystemPicker: false });
  } catch (e) { /* Electron < 30 : indisponible */ }

  protocol.handle('snd', (req) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, ''); }
    catch { return new Response('bad request', { status: 400 }); }
    const full = safeJoin(rel);
    if (!full || !AUDIO_EXT.has(path.extname(full).toLowerCase())) {
      return new Response('forbidden', { status: 403 });
    }
    const mime = ({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
      '.flac': 'audio/flac', '.webm': 'audio/webm' })[path.extname(full).toLowerCase()] || 'audio/mpeg';
    return serveFileWithRange(req, full, mime);
  });

  // Lecture des clips vidéo du replay (fichiers .webm dans userData/clips-video)
  protocol.handle('vid', (req) => {
    let name;
    try { name = path.basename(decodeURIComponent(new URL(req.url).pathname)); }
    catch { return new Response('bad request', { status: 400 }); }
    const full = path.join(videoClipsDir(), name);
    if (!full.startsWith(videoClipsDir() + path.sep) || path.extname(full).toLowerCase() !== '.webm') {
      return new Response('forbidden', { status: 403 });
    }
    return serveFileWithRange(req, full, 'video/webm');
  });

  protocol.handle('icon', (req) => {
    let name;
    try { name = path.basename(decodeURIComponent(new URL(req.url).pathname).split('?')[0]); }
    catch { return new Response('bad request', { status: 400 }); }
    const full = path.join(iconsDir(), name);
    const ext = path.extname(full).toLowerCase();
    if (!full.startsWith(iconsDir() + path.sep) || !IMAGE_EXT.has(ext)) {
      return new Response('forbidden', { status: 403 });
    }
    // Service direct par flux fichier (plus fiable que net.fetch au démarrage, où
    // le disque est très sollicité — cause des icônes qui disparaissaient).
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' })[ext] || 'image/png';
    return serveFileWithRange(req, full, mime);
  });

  createWindow();
  createTray();
  watchSounds();
});

app.on('before-quit', () => { app.isQuitting = true; stopIaBackend(); stopVcclient(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopIaBackend(); stopVcclient(); });
app.on('window-all-closed', () => app.quit());
