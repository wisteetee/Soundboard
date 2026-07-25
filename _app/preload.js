/*
 * Pont sécurisé entre l'interface (renderer) et le processus principal.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sb', {
  listSounds: () => ipcRenderer.invoke('list-sounds'),
  // État persistant (fichier userData, écriture atomique — fiable même après un kill)
  stateLoad: () => ipcRenderer.invoke('state-load'),
  stateSave: (obj) => ipcRenderer.invoke('state-save', obj),
  // Profils (bibliothèques séparées)
  profiles: {
    list: () => ipcRenderer.invoke('profiles-list'),
    create: (name) => ipcRenderer.invoke('profile-create', name),
    rename: (id, name) => ipcRenderer.invoke('profile-rename', id, name),
    remove: (id) => ipcRenderer.invoke('profile-delete', id),
    switch: (id) => ipcRenderer.invoke('profile-switch', id),
  },
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  importFiles: (paths) => ipcRenderer.invoke('import-files', paths),
  importUrl: (url) => ipcRenderer.invoke('import-url', url),
  exportConfig: (manifest) => ipcRenderer.invoke('export-config', manifest),
  importConfig: () => ipcRenderer.invoke('import-config'),
  saveClip: (wavBuffer, name) => ipcRenderer.invoke('save-clip', wavBuffer, name),
  // Clips vidéo (replay ShadowPlay)
  saveVideoClip: (buffer, name) => ipcRenderer.invoke('save-video-clip', buffer, name),
  listVideoClips: () => ipcRenderer.invoke('list-video-clips'),
  deleteVideoClip: (file) => ipcRenderer.invoke('delete-video-clip', file),
  openVideoClip: (file) => ipcRenderer.invoke('open-video-clip', file),
  revealVideoClips: () => ipcRenderer.invoke('reveal-video-clips'),
  repairVideoClips: () => ipcRenderer.invoke('repair-video-clips'),
  videoUrl: (file) => 'vid://clips/' + encodeURIComponent(file),
  rename: (file, newName) => ipcRenderer.invoke('rename', file, newName),
  remove: (file) => ipcRenderer.invoke('remove', file),
  // Catégories (sous-dossiers)
  listFolders: () => ipcRenderer.invoke('list-folders'),
  createFolder: (name) => ipcRenderer.invoke('create-folder', name),
  renameFolder: (folder, newName) => ipcRenderer.invoke('rename-folder', folder, newName),
  deleteFolder: (folder) => ipcRenderer.invoke('delete-folder', folder),
  moveSound: (file, folder) => ipcRenderer.invoke('move-sound', file, folder),
  pickIcon: (hintName) => ipcRenderer.invoke('pick-icon', hintName),
  saveIcon: (source, hintName) => ipcRenderer.invoke('save-icon', source, hintName),
  removeIcon: (imageName) => ipcRenderer.invoke('remove-icon', imageName),
  getInfo: () => ipcRenderer.invoke('get-info'),
  chooseSoundsDir: () => ipcRenderer.invoke('choose-sounds-dir'),
  openSoundsFolder: () => ipcRenderer.invoke('open-sounds-folder'),
  setGlobalHotkeys: (map, enabled, replayGrab, looper) => ipcRenderer.invoke('set-global-hotkeys', map, enabled, replayGrab, looper),
  // Suspend/reprend les raccourcis globaux (pendant la saisie dans un champ)
  suspendHotkeys: () => ipcRenderer.send('suspend-hotkeys'),
  resumeHotkeys: () => ipcRenderer.send('resume-hotkeys'),
  setOpenAtLogin: (v) => ipcRenderer.invoke('set-open-at-login', v),
  setMinimizeToTray: (v) => ipcRenderer.invoke('set-minimize-to-tray', v),
  // URL de lecture pour un fichier son (protocole custom snd://)
  soundUrl: (file) => 'snd://sounds/' + file.split('/').map(encodeURIComponent).join('/'),
  // URL d'affichage d'une image d'icône (protocole custom icon://)
  iconUrl: (image) => 'icon://icons/' + encodeURIComponent(image),
  // Récupère le vrai chemin disque d'un fichier glissé-déposé
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return null; } },
  // Événements venant du processus principal
  onSoundsChanged: (cb) => ipcRenderer.on('sounds-changed', cb),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, acc) => cb(acc)),
  onStopAll: (cb) => ipcRenderer.on('stop-all', cb),
  onReplaySave: (cb) => ipcRenderer.on('replay-save', cb),
  onLooper: (cb) => ipcRenderer.on('looper', (_e, action) => cb(action)),
  onOverlayPlay: (cb) => ipcRenderer.on('overlay-play', (_e, file) => cb(file)),
  onOverlayRefresh: (cb) => ipcRenderer.on('overlay-refresh', cb),

  // ----- Overlay in-game (mini fenêtre de favoris) -----
  overlay: {
    toggle: () => ipcRenderer.invoke('overlay-toggle'),
    close: () => ipcRenderer.invoke('overlay-close'),
    play: (file) => ipcRenderer.invoke('overlay-play', file),
    stop: () => ipcRenderer.invoke('overlay-stop'),
  },

  // ----- Câble audio virtuel (VB-Cable) -----
  cable: {
    status: () => ipcRenderer.invoke('cable-status'),
    install: () => ipcRenderer.invoke('cable-install'),
    reboot: () => ipcRenderer.invoke('cable-reboot'),
    onLog: (cb) => ipcRenderer.on('cable-log', (_e, line) => cb(line)),
  },

  // ----- VCClient (voix IA temps réel, w-okada / Beatrice) -----
  vcclient: {
    status: () => ipcRenderer.invoke('vcclient-status'),
    install: () => ipcRenderer.invoke('vcclient-install'),
    launch: () => ipcRenderer.invoke('vcclient-launch'),
    openUI: () => ipcRenderer.invoke('vcclient-open-ui'),
    stop: () => ipcRenderer.invoke('vcclient-stop'),
    api: (path, method, body) => ipcRenderer.invoke('vcclient-api', path, method, body),
    convert: (f32buf, opts) => ipcRenderer.invoke('vcclient-convert', f32buf, opts),
    onLog: (cb) => ipcRenderer.on('vcclient-log', (_e, line) => cb(line)),
  },

  // ----- YAMNet (reconnaissance de sons, BÊTA) -----
  yamnet: {
    status: () => ipcRenderer.invoke('yamnet-status'),
    ensure: () => ipcRenderer.invoke('yamnet-ensure'),
    bytes: () => ipcRenderer.invoke('yamnet-bytes'),
  },

  // ----- TTS (texte -> voix dans Discord) -----
  tts: {
    speak: (text, opts) => ipcRenderer.invoke('tts-speak', text, opts),
    save: (data, name, ext) => ipcRenderer.invoke('tts-save', data, name, ext),
  },

  // ----- Éditeur audio (découpe via ffmpeg) -----
  editor: {
    status: () => ipcRenderer.invoke('editor-status'),
    ensure: () => ipcRenderer.invoke('editor-ensure'),
    trim: (file, opts) => ipcRenderer.invoke('editor-trim', file, opts),
    normalize: (file) => ipcRenderer.invoke('editor-normalize', file),
    onLog: (cb) => ipcRenderer.on('editor-log', (_e, line) => cb(line)),
  },

  // ----- Voix IA (RVC) -----
  ia: {
    status: () => ipcRenderer.invoke('ia-status'),
    start: () => ipcRenderer.invoke('ia-start'),
    stop: () => ipcRenderer.invoke('ia-stop'),
    models: () => ipcRenderer.invoke('ia-models'),
    select: (name) => ipcRenderer.invoke('ia-select', name),
    setParams: (params) => ipcRenderer.invoke('ia-params', params),
    liveStart: (opts) => ipcRenderer.invoke('ia-live-start', opts),
    liveStop: () => ipcRenderer.invoke('ia-live-stop'),
    liveMonitor: (opts) => ipcRenderer.invoke('ia-live-monitor', opts),
    liveLevel: () => ipcRenderer.invoke('ia-live-level'),
    devices: () => ipcRenderer.invoke('ia-devices'),
    setup: () => ipcRenderer.invoke('ia-setup'),
    onLog: (cb) => ipcRenderer.on('ia-log', (_e, line) => cb(line)),
  },
});
