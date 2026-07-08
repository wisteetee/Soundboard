'use strict';

/* ================== État ================== */
const DEFAULTS = {
  discord: { enabled: true, deviceId: '', volume: 1 },
  monitor: { enabled: true, deviceId: 'default', volume: 0.5 },
  mic: { enabled: false, deviceId: 'default', gain: 1 },
  cut: false,
  globalHotkeys: true,
  hotkeys: {},   // { "accélérateur": "fichier" }  ex: "Ctrl+Alt+1"
  favs: [],      // [fichier]
  icons: {},     // { "fichier": { emoji?: "😀", color?: 180 (teinte), image?: "nom.png" } }
  voice: { preset: 'none', monitor: false, monitorVol: 0.7 },  // preset + retour casque de la voix
};
let state = loadState();
let sounds = [];
let devices = { out: [], in: [] };
let active = new Map();      // Audio -> file
const durations = new Map(); // file -> secondes
let micNodes = null;
let info = {};

function loadState() {
  try { return Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(localStorage.getItem('sb-state') || '{}')); }
  catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
function saveState() { localStorage.setItem('sb-state', JSON.stringify(state)); }

/* ================== Utilitaires ================== */
const $ = (id) => document.getElementById(id);
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}
// Fenêtre de saisie (remplace prompt(), désactivé dans Electron). Renvoie une Promise<string|null>.
function askText({ title, sub, value }) {
  return new Promise((resolve) => {
    const modal = $('promptModal');
    const input = $('promptInput');
    $('promptTitle').textContent = title || 'Saisie';
    $('promptSub').textContent = sub || '';
    input.value = value || '';
    modal.classList.add('show');
    input.focus(); input.select();

    let settled = false;
    const close = (result) => {
      if (settled) return; settled = true;
      modal.classList.remove('show');
      $('promptOk').removeEventListener('click', onOk);
      $('promptCancel').removeEventListener('click', onCancel);
      $('promptClose').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      modal.removeEventListener('mousedown', onBackdrop);
      resolve(result);
    };
    const onOk = () => { const v = input.value.trim(); close(v || null); };
    const onCancel = () => close(null);
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    const onBackdrop = (e) => { if (e.target === modal) onCancel(); };
    $('promptOk').addEventListener('click', onOk);
    $('promptCancel').addEventListener('click', onCancel);
    $('promptClose').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    modal.addEventListener('mousedown', onBackdrop);
  });
}

function norm(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
const EMOJIS = ['😂','🔥','💀','🎺','🐸','👌','💥','🚨','🤡','🗿','🎉','😱','💨','🔊','🥶','😎','🤣','👀','🐔','🦆','⚡','🎮','🏆','😈','🥴','🤖','👻','🎵','🍗','🧨','🪗','🐷'];
function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtDur(s) {
  if (!isFinite(s)) return '';
  return s < 10 ? s.toFixed(1) + 's' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
}

/* ================== Périphériques ================== */
async function refreshDevices() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
  } catch (e) { toast('⚠️ Impossible d\'accéder au micro'); }

  const all = await navigator.mediaDevices.enumerateDevices();
  devices.out = all.filter(d => d.kind === 'audiooutput');
  devices.in = all.filter(d => d.kind === 'audioinput');

  const cable = devices.out.find(d => /cable input/i.test(d.label)) || devices.out.find(d => /vb-audio|virtual/i.test(d.label));
  if (cable && !devices.out.some(d => d.deviceId === state.discord.deviceId)) {
    state.discord.deviceId = cable.deviceId;
    saveState();
  }
  fillSelect($('selDiscord'), devices.out, state.discord.deviceId);
  fillSelect($('selMonitor'), devices.out, state.monitor.deviceId);
  fillSelect($('selMic'), devices.in, state.mic.deviceId);

  const hasCable = !!cable;
  $('cableBanner').classList.toggle('show', !hasCable);
  $('cableBadge').className = 'badge ' + (hasCable ? 'ok' : 'ko');
  $('cableBadge').textContent = hasCable ? 'détecté ✓' : 'non détecté';
  $('dotCable').style.background = hasCable ? 'var(--green)' : 'var(--red)';
  $('statCable').textContent = 'Câble virtuel : ' + (hasCable ? 'OK' : 'non détecté');
}

function fillSelect(sel, list, chosen) {
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = 'default';
  def.textContent = '(Périphérique par défaut)';
  sel.appendChild(def);
  for (const d of list) {
    if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || 'Périphérique ' + sel.children.length;
    sel.appendChild(o);
  }
  sel.value = [...sel.options].some(o => o.value === chosen) ? chosen : 'default';
}

navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices().then(render));

/* ================== Lecture ================== */
async function spawnAudio(url, sinkId, vol, file) {
  const a = new Audio(url);
  a.volume = Math.min(1, vol);
  try { if (sinkId && sinkId !== 'default') await a.setSinkId(sinkId); } catch (e) {}
  active.set(a, file);
  const done = () => { active.delete(a); updatePlaying(); };
  a.onended = done;
  a.onerror = done;
  try { await a.play(); } catch (e) { done(); throw e; }
  updatePlaying();
  return a;
}

async function playSound(s) {
  if (!s) return;
  if (state.cut) stopAll(false);
  const url = window.sb.soundUrl(s.file);
  const jobs = [];
  if (state.discord.enabled && state.discord.deviceId && state.discord.deviceId !== 'default') {
    jobs.push(spawnAudio(url, state.discord.deviceId, state.discord.volume, s.file));
  }
  if (state.monitor.enabled) {
    jobs.push(spawnAudio(url, state.monitor.deviceId, state.monitor.volume, s.file));
  }
  if (!jobs.length) { toast('⚠️ Aucune sortie active — vérifie les réglages ⚙️'); return; }
  try { await Promise.all(jobs); } catch (e) { toast('Erreur de lecture : ' + e.message); }
}

function stopAll(showToast = true) {
  for (const [a] of active) { a.pause(); a.src = ''; }
  active.clear();
  updatePlaying();
  if (showToast) toast('⏹ Sons arrêtés');
}

function updatePlaying() {
  const playing = new Set(active.values());
  document.querySelectorAll('.tile').forEach(t => t.classList.toggle('playing', playing.has(t.dataset.file)));
}

async function beep(sinkId, vol) {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.value = Math.min(1, vol) * 0.4;
  osc.frequency.value = 523;
  osc.connect(g); g.connect(dest);
  const a = new Audio();
  a.srcObject = dest.stream;
  try { if (sinkId && sinkId !== 'default') await a.setSinkId(sinkId); } catch (e) {}
  await a.play();
  osc.start();
  setTimeout(() => { osc.stop(); a.pause(); ctx.close(); }, 450);
}

/* ================== Micro → Discord ================== */
async function setMicPassthrough(on) {
  if (micNodes) {
    micNodes.stream.getTracks().forEach(t => t.stop());
    micNodes.el.pause();
    if (micNodes.monEl) micNodes.monEl.pause();
    if (micNodes.fx) micNodes.fx.destroy();
    micNodes.ctx.close();
    micNodes = null;
  }
  $('dotMic').style.background = 'var(--text-dim)';
  $('statMic').textContent = 'Micro → Discord : inactif';
  if (!on) return;

  if (!state.discord.deviceId || state.discord.deviceId === 'default') {
    toast('⚠️ Choisis d\'abord CABLE Input dans "Sortie vers Discord"');
    state.mic.enabled = false; $('swMic').checked = false; saveState();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: state.mic.deviceId && state.mic.deviceId !== 'default' ? { exact: state.mic.deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      }
    });
    const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = state.mic.gain;
    const dest = ctx.createMediaStreamDestination();

    // Chaîne de modulation de voix insérée entre le gain et la sortie
    const fx = new VoiceFX(ctx);
    await fx.initPitch('../vendor/soundtouch-processor.js');
    fx.applyPreset(currentVoicePreset());
    src.connect(gain);
    gain.connect(fx.input);
    fx.output.connect(dest);

    // Sortie vers le câble virtuel (Discord)
    const el = new Audio();
    el.srcObject = dest.stream;
    await el.setSinkId(state.discord.deviceId);
    await el.play();

    // Retour casque de TA voix (pour t'entendre transformé) — séparé, optionnel
    const monDest = ctx.createMediaStreamDestination();
    const monGain = ctx.createGain();
    monGain.gain.value = state.voice.monitor ? state.voice.monitorVol : 0;
    fx.output.connect(monGain);
    monGain.connect(monDest);
    const monEl = new Audio();
    monEl.srcObject = monDest.stream;
    try {
      const sink = state.monitor.deviceId && state.monitor.deviceId !== 'default' ? state.monitor.deviceId : '';
      if (sink) await monEl.setSinkId(sink);
    } catch (e) {}
    await monEl.play();

    micNodes = { stream, ctx, gain, el, fx, monGain, monEl };
    $('dotMic').style.background = 'var(--green)';
    $('statMic').textContent = 'Micro → Discord : actif 🎤';
    updateVoiceStatus();
    toast('🎤 Ta voix passe maintenant par le câble virtuel');
  } catch (e) {
    toast('Erreur micro : ' + e.message);
    state.mic.enabled = false; $('swMic').checked = false; saveState();
  }
}

/* ================== Modulation de voix ================== */
function currentVoicePreset() {
  return (window.VOICE_PRESETS || []).find(p => p.id === state.voice.preset)
    || window.VOICE_PRESETS[0];
}

// Change de preset ; applique en direct si le micro tourne, sinon mémorise pour le prochain démarrage
function setVoicePreset(id) {
  state.voice.preset = id;
  saveState();
  const preset = currentVoicePreset();
  if (micNodes && micNodes.fx) {
    micNodes.fx.applyPreset(preset);
  }
  renderVoice();
  updateVoiceStatus();
}

// Active/coupe le retour casque de ta voix modifiée (pour t'entendre)
function applyVoiceMonitor() {
  if (micNodes && micNodes.monGain) {
    micNodes.monGain.gain.value = state.voice.monitor ? state.voice.monitorVol : 0;
  }
}
function setVoiceMonitor(on) {
  state.voice.monitor = on;
  saveState();
  applyVoiceMonitor();
  updateVoiceStatus();
  if (on && !state.mic.enabled) {
    // sans le micro actif, il n'y a rien à écouter : on l'active
    state.mic.enabled = true; $('swMic').checked = true; saveState();
    setMicPassthrough(true);
  }
}

function updateVoiceStatus() {
  const p = currentVoicePreset();
  const dot = $('dotVoice'), stat = $('statVoice');
  if (!dot) return;
  const active = p.id !== 'none';
  dot.style.background = active ? 'var(--blurple)' : 'var(--text-dim)';
  stat.textContent = 'Voix : ' + (active ? p.emoji + ' ' + p.name : 'normale');
  const warn = $('voiceMicWarn');
  if (warn) warn.style.display = (state.mic.enabled ? 'none' : 'block');
  const sw = $('swVoiceMon');
  if (sw) sw.checked = state.voice.monitor;
}

// Construit la grille de presets de voix
function renderVoice() {
  const grid = $('voiceGrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const p of window.VOICE_PRESETS) {
    const el = document.createElement('div');
    el.className = 'vtile' + (p.id === state.voice.preset ? ' sel' : '');
    el.innerHTML = '<span class="vemoji">' + p.emoji + '</span><div class="vname">' + esc(p.name) + '</div>';
    el.addEventListener('click', () => setVoicePreset(p.id));
    grid.appendChild(el);
  }
}

/* ================== Rendu ================== */
function keyFor(file) { return Object.entries(state.hotkeys).find(([, f]) => f === file)?.[0]; }

// Apparence effective d'un son : personnalisation si présente, sinon auto (dérivée du nom)
function iconOf(file) {
  const custom = state.icons[file] || {};
  const h = hash(file);
  return {
    emoji: custom.emoji || EMOJIS[h % EMOJIS.length],
    hue: (custom.color != null) ? custom.color : (h % 360),
    image: custom.image || null,
  };
}

// HTML de la pastille d'icône (image OU emoji sur fond coloré)
function iconHtml(file) {
  const ic = iconOf(file);
  if (ic.image) {
    return '<span class="emoji img"><img src="' + esc(window.sb.iconUrl(ic.image)) + '" alt=""></span>';
  }
  const bg = 'linear-gradient(135deg,hsl(' + ic.hue + ',60%,38%),hsl(' + ((ic.hue + 45) % 360) + ',65%,26%))';
  return '<span class="emoji" style="background:' + bg + '">' + ic.emoji + '</span>';
}

function tileFor(s) {
  const t = document.createElement('div');
  t.className = 'tile' + (state.favs.includes(s.file) ? ' fav' : '');
  t.dataset.file = s.file;
  const key = keyFor(s.file);
  t.innerHTML =
    '<span class="star" title="Favori">⭐</span>' +
    (key ? '<span class="key">' + esc(key) + '</span>' : '') +
    iconHtml(s.file) +
    '<div class="name">' + esc(s.name) + '</div>' +
    '<div class="dur">' + (durations.has(s.file) ? fmtDur(durations.get(s.file)) : '…') + '</div>';
  t.addEventListener('click', (e) => {
    if (e.target.classList.contains('star')) { toggleFav(s); return; }
    playSound(s);
  });
  t.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtx(e, s); });
  if (!durations.has(s.file)) loadDuration(s, t);
  return t;
}

function loadDuration(s, tile) {
  const a = new Audio();
  a.preload = 'metadata';
  a.src = window.sb.soundUrl(s.file);
  a.onloadedmetadata = () => {
    durations.set(s.file, a.duration);
    const d = tile.querySelector('.dur');
    if (d) d.textContent = fmtDur(a.duration);
    a.src = '';
  };
}

function render() {
  const q = norm($('search').value.trim());
  const filtered = q ? sounds.filter(s => norm(s.name).includes(q)) : sounds;
  const c = $('content');
  c.innerHTML = '';

  if (!sounds.length) {
    c.innerHTML = '<div class="empty"><div class="big">📂</div>' +
      'Aucun son pour l\'instant !<br>' +
      'Clique sur <b>➕ Ajouter des sons</b> ou glisse des fichiers MP3/WAV/OGG ici.<br>' +
      '<span style="font-size:12.5px">Tu peux trouver des memes vocaux sur myinstants.com 😉</span></div>';
    return;
  }
  if (!filtered.length) {
    c.innerHTML = '<div class="empty"><div class="big">🔍</div>Aucun résultat pour « ' + esc(q) + ' »</div>';
    return;
  }

  const favs = filtered.filter(s => state.favs.includes(s.file));
  const groups = new Map();
  for (const s of filtered) {
    const g = s.folder || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }

  const addSection = (title, list) => {
    if (!list.length) return;
    const h = document.createElement('div');
    h.className = 'section-title';
    h.textContent = title;
    c.appendChild(h);
    const g = document.createElement('div');
    g.className = 'grid';
    for (const s of list) g.appendChild(tileFor(s));
    c.appendChild(g);
  };

  if (favs.length) addSection('⭐ Favoris', favs);
  const multi = groups.size > 1;
  for (const [folder, list] of [...groups.entries()].sort()) {
    addSection(multi ? (folder ? '📁 ' + folder : '📁 Général') : 'Tous les sons — ' + list.length, list);
  }
  updatePlaying();
}

function toggleFav(s) {
  const i = state.favs.indexOf(s.file);
  if (i >= 0) state.favs.splice(i, 1); else state.favs.push(s.file);
  saveState();
  render();
}

/* ================== Menu contextuel ================== */
let ctxSound = null;
function openCtx(e, s) {
  ctxSound = s;
  const ctx = $('ctx');
  const isFav = state.favs.includes(s.file);
  const key = keyFor(s.file);
  ctx.innerHTML =
    '<div data-act="play">▶️ Jouer</div>' +
    '<div data-act="fav">' + (isFav ? '💔 Retirer des favoris' : '⭐ Ajouter aux favoris') + '</div>' +
    '<div data-act="icon">🎨 Changer l\'icône</div>' +
    '<div data-act="key">⌨️ ' + (key ? 'Changer la touche (' + esc(key) + ')' : 'Assigner une touche') + '</div>' +
    (key ? '<div data-act="unkey">🚫 Retirer la touche</div>' : '') +
    '<div data-act="rename">✏️ Renommer</div>' +
    '<div data-act="del" class="danger">🗑️ Supprimer</div>';
  ctx.style.display = 'block';
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(e.clientX, innerWidth - r.width - 10) + 'px';
  ctx.style.top = Math.min(e.clientY, innerHeight - r.height - 10) + 'px';
}
document.addEventListener('click', () => { $('ctx').style.display = 'none'; });
$('ctx').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const s = ctxSound;
  if (!act || !s) return;
  if (act === 'play') playSound(s);
  if (act === 'fav') toggleFav(s);
  if (act === 'icon') openIconEditor(s);
  if (act === 'key') captureKey(s);
  if (act === 'unkey') {
    for (const [k, f] of Object.entries(state.hotkeys)) if (f === s.file) delete state.hotkeys[k];
    saveState(); applyGlobalHotkeys(); render();
  }
  if (act === 'rename') {
    const n = await askText({ title: '✏️ Renommer le son', sub: 'Nouveau nom (sans l\'extension)', value: s.name });
    if (n && n.trim() && n.trim() !== s.name) {
      const r = await window.sb.rename(s.file, n.trim());
      if (r.ok) {
        const i = state.favs.indexOf(s.file);
        if (i >= 0) state.favs[i] = r.file;
        for (const k of Object.keys(state.hotkeys)) if (state.hotkeys[k] === s.file) state.hotkeys[k] = r.file;
        if (state.icons[s.file]) { state.icons[r.file] = state.icons[s.file]; delete state.icons[s.file]; }
        saveState();
        await loadSounds();
        applyGlobalHotkeys();
      } else toast('❌ ' + (r.error || 'Erreur'));
    }
  }
  if (act === 'del') {
    if (confirm('Supprimer « ' + s.name + ' » ?\n(Le fichier sera déplacé dans le dossier _corbeille)')) {
      const r = await window.sb.remove(s.file);
      if (r.ok) {
        const ic = state.icons[s.file];
        if (ic) { if (ic.image) window.sb.removeIcon(ic.image); delete state.icons[s.file]; saveState(); }
        toast('🗑️ Déplacé dans _corbeille'); await loadSounds();
      } else toast('❌ ' + (r.error || 'Erreur'));
    }
  }
});

/* ================== Éditeur d'icône ================== */
// Palette d'emojis proposée (memes / réactions)
const EMOJI_PALETTE = [
  '😂','🤣','😭','😱','😳','😎','🥶','🥴','🤡','👻','💀','🗿','👀','🤖','😈','👽',
  '🔥','💥','⚡','✨','🎉','🚨','💨','💣','🧨','🔊','📢','🎵','🎺','🥁','🪗','🎸','🎮',
  '👌','👍','🖕','🙏','💪','🤝','👏','🫡','🤌','✊','🎯','🏆','💯','❤️','💔','⭐',
  '🐸','🐔','🦆','🐷','🐒','🐶','🐱','🦍','🍗','🍕','🧀','🥚','🚀','💩','🤮','😴',
];
// Teintes de couleur proposées (0-360)
const COLOR_PALETTE = [0, 20, 40, 130, 160, 190, 210, 240, 270, 300, 330, 355];

let iconEditing = null;   // fichier en cours d'édition
let iconDraft = null;     // { emoji, color, image } en cours (non sauvé tant que non validé)

function openIconEditor(s) {
  iconEditing = s.file;
  const cur = state.icons[s.file] || {};
  iconDraft = { emoji: cur.emoji || null, color: (cur.color != null ? cur.color : null), image: cur.image || null };
  $('iconSoundName').textContent = s.name;

  // grille d'emojis
  const grid = $('emojiGrid');
  grid.innerHTML = EMOJI_PALETTE.map(e => '<span data-emoji="' + e + '">' + e + '</span>').join('');
  // palette de couleurs
  $('colorRow').innerHTML = COLOR_PALETTE.map(h =>
    '<span class="swatch" data-hue="' + h + '" style="background:hsl(' + h + ',60%,42%)"></span>').join('');

  refreshIconEditor();
  $('iconModal').classList.add('show');
}

function refreshIconEditor() {
  // aperçu
  const prev = $('iconPreview');
  if (iconDraft.image) {
    prev.innerHTML = '<img src="' + esc(window.sb.iconUrl(iconDraft.image)) + '" alt="">';
    prev.style.background = 'var(--bg-dark)';
  } else {
    const h = (iconDraft.color != null) ? iconDraft.color : (hash(iconEditing) % 360);
    const emoji = iconDraft.emoji || EMOJIS[hash(iconEditing) % EMOJIS.length];
    prev.innerHTML = emoji;
    prev.style.background = 'linear-gradient(135deg,hsl(' + h + ',60%,38%),hsl(' + ((h + 45) % 360) + ',65%,26%))';
  }
  // sélections
  document.querySelectorAll('#emojiGrid span').forEach(el =>
    el.classList.toggle('sel', !iconDraft.image && el.dataset.emoji === iconDraft.emoji));
  document.querySelectorAll('#colorRow .swatch').forEach(el =>
    el.classList.toggle('sel', !iconDraft.image && iconDraft.color != null && +el.dataset.hue === iconDraft.color));
  $('iconRemoveImg').style.display = iconDraft.image ? 'inline-block' : 'none';
}

function closeIconEditor() {
  $('iconModal').classList.remove('show');
  iconEditing = null; iconDraft = null;
}

// Applique le brouillon dans l'état et sauvegarde
function commitIcon() {
  if (!iconEditing) return;
  const d = iconDraft;
  if (!d.emoji && d.color == null && !d.image) delete state.icons[iconEditing];
  else state.icons[iconEditing] = {
    ...(d.emoji ? { emoji: d.emoji } : {}),
    ...(d.color != null ? { color: d.color } : {}),
    ...(d.image ? { image: d.image } : {}),
  };
  saveState();
  render();
}

// Enregistre une image (chemin disque ou data:) comme icône du son courant
async function setIconImage(source) {
  if (!iconEditing) return;
  const r = await window.sb.saveIcon(source, $('iconSoundName').textContent);
  if (r && r.ok) {
    // supprime l'ancienne image si elle existait
    const old = state.icons[iconEditing]?.image;
    if (old && old !== r.image) window.sb.removeIcon(old);
    if (iconDraft.image && iconDraft.image !== r.image) window.sb.removeIcon(iconDraft.image);
    iconDraft.image = r.image;
    refreshIconEditor();
    commitIcon();
    toast('🖼️ Image appliquée');
  } else toast('❌ ' + ((r && r.error) || 'Échec de l\'image'));
}

// Sélections dans l'éditeur
$('emojiGrid').addEventListener('click', (e) => {
  const em = e.target.closest('[data-emoji]');
  if (!em) return;
  iconDraft.emoji = (iconDraft.emoji === em.dataset.emoji) ? null : em.dataset.emoji;
  iconDraft.image = null;   // choisir un emoji retire l'image
  refreshIconEditor();
  commitIcon();
});
$('colorRow').addEventListener('click', (e) => {
  const sw = e.target.closest('[data-hue]');
  if (!sw) return;
  const h = +sw.dataset.hue;
  iconDraft.color = (iconDraft.color === h) ? null : h;
  iconDraft.image = null;
  refreshIconEditor();
  commitIcon();
});
$('iconPickBtn').addEventListener('click', async () => {
  const r = await window.sb.pickIcon($('iconSoundName').textContent);
  if (r && r.ok) {
    const old = iconDraft.image;
    if (old && old !== r.image) window.sb.removeIcon(old);
    iconDraft.image = r.image;
    refreshIconEditor();
    commitIcon();
    toast('🖼️ Image appliquée');
  } else if (r && r.error) toast('❌ ' + r.error);
});
$('iconRemoveImg').addEventListener('click', () => {
  if (iconDraft.image) window.sb.removeIcon(iconDraft.image);
  iconDraft.image = null;
  refreshIconEditor();
  commitIcon();
});
$('iconReset').addEventListener('click', () => {
  if (iconDraft.image) window.sb.removeIcon(iconDraft.image);
  iconDraft = { emoji: null, color: null, image: null };
  refreshIconEditor();
  commitIcon();
  toast('↺ Icône réinitialisée');
});
$('iconDone').addEventListener('click', closeIconEditor);
$('iconClose').addEventListener('click', closeIconEditor);
$('iconModal').addEventListener('click', (e) => { if (e.target.id === 'iconModal') closeIconEditor(); });

// Glisser-déposer d'une image directement dans l'éditeur
const iconDropZone = $('iconDrop');
iconDropZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); iconDropZone.classList.add('drag'); });
iconDropZone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); iconDropZone.classList.remove('drag'); });
iconDropZone.addEventListener('drop', (e) => {
  e.preventDefault(); e.stopPropagation();
  iconDropZone.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (!/^image\//.test(f.type) && !/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name)) { toast('⚠️ Ce n\'est pas une image'); return; }
  const p = window.sb.pathForFile(f);
  if (p) { setIconImage(p); return; }
  // secours : lire en data URL
  const reader = new FileReader();
  reader.onload = () => setIconImage(reader.result);
  reader.readAsDataURL(f);
});

/* ================== Capture d'un accélérateur ================== */
let capturing = null;
function captureKey(s) {
  capturing = s;
  $('keyCaptureName').textContent = '« ' + s.name + ' »';
  $('keyCapture').classList.add('show');
}

// Convertit un KeyboardEvent en accélérateur Electron (ex: "Ctrl+Alt+1")
function toAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  let key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null; // modificateur seul
  if (key === ' ') key = 'Space';
  else if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
  else if (/^Arrow/.test(key)) key = key.replace('Arrow', '');
  else if (key.length === 1) {
    // chiffres/symboles : utilise le code physique pour rester stable
    const m = /^(Digit|Numpad)(\d)$/.exec(e.code);
    if (m) key = (m[1] === 'Numpad' ? 'num' : '') + m[2];
  }
  return [...mods, key].join('+');
}

document.addEventListener('keydown', (e) => {
  // Une fenêtre de saisie est ouverte : elle gère ses propres touches
  if ($('promptModal').classList.contains('show')) return;
  // L'éditeur d'icône est ouvert : Échap ferme, on ne déclenche pas les raccourcis
  if ($('iconModal').classList.contains('show')) {
    if (e.key === 'Escape') closeIconEditor();
    return;
  }
  if (capturing) {
    const s = capturing;
    if (e.key === 'Escape') { capturing = null; $('keyCapture').classList.remove('show'); return; }
    if (e.key === 'Delete') {
      capturing = null; $('keyCapture').classList.remove('show');
      for (const [k, f] of Object.entries(state.hotkeys)) if (f === s.file) delete state.hotkeys[k];
      saveState(); applyGlobalHotkeys(); render();
      return;
    }
    const acc = toAccelerator(e);
    if (!acc) return; // attend une vraie touche (pas juste un modificateur)
    e.preventDefault();
    capturing = null;
    $('keyCapture').classList.remove('show');
    delete state.hotkeys[acc];
    for (const [k, f] of Object.entries(state.hotkeys)) if (f === s.file) delete state.hotkeys[k];
    state.hotkeys[acc] = s.file;
    saveState();
    applyGlobalHotkeys();
    render();
    toast('⌨️ « ' + s.name + ' » → ' + acc);
    return;
  }

  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === 'Escape') { stopAll(); return; }

  // Raccourci local (marche quand la fenêtre a le focus, même sans "globaux")
  const acc = toAccelerator(e);
  if (acc && state.hotkeys[acc]) {
    e.preventDefault();
    playSound(sounds.find(x => x.file === state.hotkeys[acc]));
  }
});

/* ================== Raccourcis globaux (via Electron) ================== */
async function applyGlobalHotkeys() {
  const r = await window.sb.setGlobalHotkeys(state.hotkeys, state.globalHotkeys);
  const warn = $('globalWarn');
  if (state.globalHotkeys && r && r.failed && r.failed.length) {
    warn.textContent = '⚠️ Impossible d\'enregistrer : ' + r.failed.join(', ') + ' (déjà utilisé par une autre appli). Choisis une autre combinaison.';
  } else warn.textContent = '';
}

/* ================== Chargement ================== */
async function loadSounds() {
  sounds = await window.sb.listSounds();
  $('statApp').textContent = 'Application prête · ' + sounds.length + ' son' + (sounds.length > 1 ? 's' : '');
  render();
}

/* ================== Import de fichiers ================== */
async function importDropped(fileList) {
  const paths = [];
  for (const f of fileList) {
    const p = window.sb.pathForFile(f);
    if (p) paths.push(p);
  }
  if (!paths.length) { toast('⚠️ Fichiers non reconnus'); return; }
  const r = await window.sb.importFiles(paths);
  reportImport(r);
  await loadSounds();
}
function reportImport(r) {
  if (r.ok) toast('✅ ' + r.ok + ' son' + (r.ok > 1 ? 's' : '') + ' ajouté' + (r.ok > 1 ? 's' : '') + ' !');
  if (r.fail) toast('⚠️ ' + r.fail + ' fichier(s) refusé(s) — formats : mp3, wav, ogg, m4a, flac…', 4000);
  if (!r.ok && !r.fail) toast('Aucun fichier ajouté');
}

$('btnAdd').addEventListener('click', async () => {
  const r = await window.sb.pickFiles();
  reportImport(r);
  await loadSounds();
});

let dragDepth = 0;
const iconModalOpen = () => $('iconModal').classList.contains('show');
addEventListener('dragenter', (e) => { e.preventDefault(); if (iconModalOpen()) return; if (++dragDepth === 1) $('dropOverlay').classList.add('show'); });
addEventListener('dragleave', (e) => { e.preventDefault(); if (iconModalOpen()) return; if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.remove('show'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').classList.remove('show');
  if (iconModalOpen()) return;   // les images déposées sur l'éditeur sont gérées à part
  if (e.dataTransfer.files.length) importDropped([...e.dataTransfer.files]);
});

/* ================== Bindings réglages ================== */
function bindSwitch(id, get, set) {
  const el = $(id);
  el.checked = get();
  el.addEventListener('change', () => { set(el.checked); saveState(); });
}
function bindSelect(id, get, set) {
  const el = $(id);
  el.addEventListener('change', () => { set(el.value); saveState(); });
}
function bindVol(id, lblId, get, set) {
  const el = $(id), lbl = $(lblId);
  el.value = Math.round(get() * 100);
  lbl.textContent = el.value + '%';
  el.addEventListener('input', () => { lbl.textContent = el.value + '%'; set(el.value / 100); saveState(); });
}

bindSwitch('swDiscord', () => state.discord.enabled, v => state.discord.enabled = v);
bindSwitch('swMonitor', () => state.monitor.enabled, v => state.monitor.enabled = v);
bindSwitch('swCut', () => state.cut, v => state.cut = v);
bindSwitch('swMic', () => state.mic.enabled, v => { state.mic.enabled = v; setMicPassthrough(v); });
bindSwitch('swGlobal', () => state.globalHotkeys, v => { state.globalHotkeys = v; applyGlobalHotkeys(); });
bindSelect('selDiscord', () => state.discord.deviceId, v => { state.discord.deviceId = v; if (state.mic.enabled) setMicPassthrough(true); });
bindSelect('selMonitor', () => state.monitor.deviceId, v => {
  state.monitor.deviceId = v;
  // le retour casque de la voix suit le même périphérique
  if (micNodes && micNodes.monEl) {
    const sink = v && v !== 'default' ? v : '';
    micNodes.monEl.setSinkId(sink).catch(() => {});
  }
});
bindSelect('selMic', () => state.mic.deviceId, v => { state.mic.deviceId = v; if (state.mic.enabled) setMicPassthrough(true); });
bindVol('volDiscord', 'volDiscordLbl', () => state.discord.volume, v => state.discord.volume = v);
bindVol('volMonitor', 'volMonitorLbl', () => state.monitor.volume, v => state.monitor.volume = v);
bindVol('volMic', 'volMicLbl', () => state.mic.gain, v => { state.mic.gain = v; if (micNodes) micNodes.gain.gain.value = v; });

$('btnSettings').addEventListener('click', () => $('settings').classList.toggle('open'));
$('btnStop').addEventListener('click', () => stopAll());
$('btnRandom').addEventListener('click', () => { if (sounds.length) playSound(sounds[Math.floor(Math.random() * sounds.length)]); });
$('search').addEventListener('input', render);
$('testDiscord').addEventListener('click', () => {
  if (!state.discord.deviceId || state.discord.deviceId === 'default') { toast('⚠️ Choisis d\'abord CABLE Input'); return; }
  beep(state.discord.deviceId, state.discord.volume);
  toast('🎵 Bip envoyé — quelqu\'un dans le vocal doit l\'entendre');
});
$('rescanDevices').addEventListener('click', (e) => { e.preventDefault(); refreshDevices().then(render); });
$('openDir').addEventListener('click', () => window.sb.openSoundsFolder());
$('changeDir').addEventListener('click', async () => {
  const d = await window.sb.chooseSoundsDir();
  if (d) { $('dirPath').textContent = d; await loadSounds(); toast('📁 Dossier changé'); }
});

/* Bindings fenêtre/système (état lu depuis le processus principal) */
$('swTray').addEventListener('change', (e) => window.sb.setMinimizeToTray(e.target.checked));
$('swLogin').addEventListener('change', async (e) => {
  const v = await window.sb.setOpenAtLogin(e.target.checked);
  e.target.checked = v;
});

/* ================== Onglets Sons / Voix ================== */
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const isVoice = tab === 'voice';
  $('content').style.display = isVoice ? 'none' : '';
  $('voiceView').style.display = isVoice ? 'block' : 'none';
  $('search').style.visibility = isVoice ? 'hidden' : '';
  $('btnRandom').style.display = isVoice ? 'none' : '';
  $('btnAdd').style.display = isVoice ? 'none' : '';
  if (isVoice) { renderVoice(); updateVoiceStatus(); }
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
$('voiceEnableMic').addEventListener('click', () => {
  state.mic.enabled = true; $('swMic').checked = true; saveState();
  setMicPassthrough(true);
  updateVoiceStatus();
});
$('swVoiceMon').addEventListener('change', (e) => setVoiceMonitor(e.target.checked));

/* ================== Événements Electron ================== */
window.sb.onSoundsChanged(() => loadSounds());
window.sb.onHotkey((acc) => { const f = state.hotkeys[acc]; if (f) playSound(sounds.find(x => x.file === f)); });
window.sb.onStopAll(() => stopAll());

/* ================== Démarrage ================== */
(async function init() {
  info = await window.sb.getInfo();
  $('dirPath').textContent = info.soundsDir;
  $('versionLbl').textContent = 'Soundboard Discord v' + info.version;
  $('stopAccel').textContent = info.stopAccelerator || 'Ctrl+Alt+X';
  $('swTray').checked = info.minimizeToTray;
  $('swLogin').checked = info.openAtLogin;

  await loadSounds();
  await refreshDevices();
  await applyGlobalHotkeys();
  render();
  renderVoice();
  updateVoiceStatus();

  if (!localStorage.getItem('sb-visited')) {
    localStorage.setItem('sb-visited', '1');
    $('settings').classList.add('open');
  }
})();
