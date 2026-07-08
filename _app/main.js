/*
 * Soundboard Discord — processus principal Electron
 * Fenêtre, tray, raccourcis globaux, accès aux fichiers sons.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, globalShortcut, shell, protocol, net, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm', '.aac', '.opus']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const STOP_ACCELERATOR = 'Ctrl+Alt+X';

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

/* ---------- Scan des sons ---------- */
function listSounds() {
  const root = soundsDir();
  const out = [];
  (function scan(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('_') || e.name.startsWith('.') || e.name === 'node_modules') continue;
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
  for (const p of paths || []) {
    try {
      const ext = path.extname(p).toLowerCase();
      if (!AUDIO_EXT.has(ext)) { fail++; continue; }
      const base = sanitizeName(path.basename(p, ext)) || 'son';
      fs.copyFileSync(p, uniquePath(soundsDir(), base, ext));
      ok++;
    } catch { fail++; }
  }
  return { ok, fail };
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
  }
  return { registered, failed };
}

/* ---------- Protocole snd:// (lecture des fichiers audio) ---------- */
protocol.registerSchemesAsPrivileged([
  { scheme: 'snd', privileges: { standard: true, stream: true, supportFetchAPI: true } },
  { scheme: 'icon', privileges: { standard: true, supportFetchAPI: true } },
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
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

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
}));

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

  protocol.handle('snd', (req) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, ''); }
    catch { return new Response('bad request', { status: 400 }); }
    const full = safeJoin(rel);
    if (!full || !AUDIO_EXT.has(path.extname(full).toLowerCase())) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(full).toString());
  });

  protocol.handle('icon', (req) => {
    let name;
    try { name = path.basename(decodeURIComponent(new URL(req.url).pathname)); }
    catch { return new Response('bad request', { status: 400 }); }
    const full = path.join(iconsDir(), name);
    if (!full.startsWith(iconsDir() + path.sep) || !IMAGE_EXT.has(path.extname(full).toLowerCase()) || !fs.existsSync(full)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(full).toString());
  });

  createWindow();
  createTray();
  watchSounds();
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
