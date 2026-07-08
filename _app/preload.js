/*
 * Pont sécurisé entre l'interface (renderer) et le processus principal.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sb', {
  listSounds: () => ipcRenderer.invoke('list-sounds'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  importFiles: (paths) => ipcRenderer.invoke('import-files', paths),
  rename: (file, newName) => ipcRenderer.invoke('rename', file, newName),
  remove: (file) => ipcRenderer.invoke('remove', file),
  pickIcon: (hintName) => ipcRenderer.invoke('pick-icon', hintName),
  saveIcon: (source, hintName) => ipcRenderer.invoke('save-icon', source, hintName),
  removeIcon: (imageName) => ipcRenderer.invoke('remove-icon', imageName),
  getInfo: () => ipcRenderer.invoke('get-info'),
  chooseSoundsDir: () => ipcRenderer.invoke('choose-sounds-dir'),
  openSoundsFolder: () => ipcRenderer.invoke('open-sounds-folder'),
  setGlobalHotkeys: (map, enabled) => ipcRenderer.invoke('set-global-hotkeys', map, enabled),
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
});
