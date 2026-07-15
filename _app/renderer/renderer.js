'use strict';

/* ================== État ================== */
const DEFAULTS = {
  discord: { enabled: true, deviceId: '', volume: 1 },
  monitor: { enabled: true, deviceId: 'default', volume: 0.5 },
  mic: { enabled: false, deviceId: 'default', gain: 1, denoise: false, denoiseStrength: 0.6 },
  cut: false,
  globalHotkeys: true,
  hotkeys: {},   // { "accélérateur": "fichier" }  ex: "Ctrl+Alt+1"
  favs: [],      // [fichier]
  icons: {},     // { "fichier": { emoji?: "😀", color?: 180 (teinte), image?: "nom.png" } }
  voice: { preset: 'none', monitor: false, monitorVol: 0.7 },  // preset + retour casque de la voix
  ia: { model: null, pitch: 0, indexRate: 0 },  // voix IA (RVC)
  volumes: {},   // { "fichier": 0..1 } volume individuel (molette sur la tuile)
  plays: {},     // { "fichier": nombre de lectures }
  sort: 'name',  // tri des sons : name | plays | recent
  collapsed: [], // catégories repliées
  catOrder: [],  // ordre personnalisé des catégories (boutons ▲▼)
  view: 'grid',  // densité d'affichage des sons : grid | compact | list
  onboard: { dismissed: false, discordDone: false },  // checklist premier lancement
  replay: { source: 'mic', seconds: 5, auto: false, autoClip: false,
            yamCats: ['laugh', 'applause', 'shout'], yamAutoClip: false,
            mode: 'audio',   // onglet interne : audio | video
            // replay vidéo (ShadowPlay)
            video: { audio: 'system', seconds: 30, quality: '1080', auto: false } },
  theme: 'discord', // thème de couleur (voir THEMES)
  normalizeImport: false, // normaliser le volume des sons à l'import (loudnorm)
  tts: { voice: 'fr-FR-DeniseNeural', rate: 1, pitch: 0, history: [] }, // onglet Dire
};
let state = loadState();
let sounds = [];
let folders = [];            // catégories (sous-dossiers), y compris vides
let draggingSound = null;    // fichier en cours de glisser-déposer interne
let devices = { out: [], in: [] };
let active = new Map();      // Audio -> file
const durations = new Map(); // file -> secondes
let micNodes = null;
let info = {};

// Fusion profonde : un état sauvegardé par une ancienne version garde les
// valeurs par défaut des champs ajoutés depuis (sinon ils seraient perdus
// par une fusion superficielle -> gains « undefined » -> erreurs non-finite).
function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)
    || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
    out[k] = deepMerge(base[k], over[k]);
  }
  return out;
}
function loadState() {
  const defs = JSON.parse(JSON.stringify(DEFAULTS));
  try { return deepMerge(defs, JSON.parse(localStorage.getItem('sb-state') || '{}')); }
  catch { return defs; }
}
function saveState() { localStorage.setItem('sb-state', JSON.stringify(state)); }
// Garde-fou : jamais de valeur non-finie dans un AudioParam
function fin(v, d) { return Number.isFinite(v) ? v : d; }

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
  const a = new Audio();
  a.preload = 'auto';
  a.volume = Math.min(1, Math.max(0, vol));
  // Router le périphérique de sortie AVANT de charger la source : changer le sink
  // sur un élément déjà en lecture réinitialise le pipeline audio de Chromium et
  // fait « redémarrer » le son du début. En le fixant avant src, aucun re-départ.
  try { if (sinkId && sinkId !== 'default') await a.setSinkId(sinkId); } catch (e) {}
  a.src = url;
  active.set(a, file);
  const done = () => { active.delete(a); updatePlaying(); };
  a.onended = done;
  a.onerror = done;
  // barre de progression sur la tuile
  a.addEventListener('timeupdate', () => {
    if (!a.duration || !active.has(a)) return;
    const bar = document.querySelector('.tile[data-file="' + CSS.escape(file) + '"] .bar');
    if (bar) bar.style.width = ((a.currentTime / a.duration) * 100).toFixed(1) + '%';
  });
  // attend d'avoir assez de données décodées pour lire d'une traite (évite le
  // hoquet start/stop quand le décodage n'est pas prêt au moment du play()).
  try {
    if (a.readyState < 3) {
      await new Promise((res) => {
        const ok = () => { a.removeEventListener('canplaythrough', ok); a.removeEventListener('error', ok); res(); };
        a.addEventListener('canplaythrough', ok, { once: true });
        a.addEventListener('error', ok, { once: true });
        setTimeout(ok, 1500);   // filet de sécurité : ne bloque jamais plus d'1,5 s
      });
    }
    await a.play();
  } catch (e) { done(); throw e; }
  updatePlaying();
  return a;
}

// localOnly = écoute privée : joue uniquement dans le casque, rien vers Discord
async function playSound(s, { localOnly = false } = {}) {
  if (!s) return;
  if (state.cut) stopAll(false);
  const url = window.sb.soundUrl(s.file);
  const svol = fin(state.volumes[s.file], 1);   // volume individuel du son
  const jobs = [];
  if (!localOnly && state.discord.enabled && state.discord.deviceId && state.discord.deviceId !== 'default') {
    jobs.push(spawnAudio(url, state.discord.deviceId, state.discord.volume * svol, s.file));
  }
  if (state.monitor.enabled || localOnly) {
    const mv = localOnly ? Math.max(state.monitor.volume, 0.5) : state.monitor.volume;
    jobs.push(spawnAudio(url, state.monitor.deviceId, mv * svol, s.file));
  }
  if (!jobs.length) { toast('⚠️ Aucune sortie active — vérifie les réglages ⚙️'); return; }
  if (!localOnly) {
    state.plays[s.file] = (state.plays[s.file] || 0) + 1;
    saveState();
    if ($('onboard').style.display !== 'none') renderOnboard();   // coche « premier son joué »
  }
  try { await Promise.all(jobs); } catch (e) { toast('Erreur de lecture : ' + e.message); }
}

function stopAll(showToast = true) {
  // fondu de ~150 ms : coupe sans « clac » dans le vocal
  const list = [...active.keys()];
  active.clear();
  updatePlaying();
  for (const a of list) {
    const step = Math.max(0.02, a.volume / 8);
    const t = setInterval(() => {
      if (a.volume > step) a.volume -= step;
      else { clearInterval(t); a.pause(); a.src = ''; }
    }, 18);
  }
  if (showToast) toast('⏹ Sons arrêtés');
}

function updatePlaying() {
  const playing = new Set(active.values());
  document.querySelectorAll('.tile').forEach(t => {
    const on = playing.has(t.dataset.file);
    t.classList.toggle('playing', on);
    if (!on) { const b = t.querySelector('.bar'); if (b) b.style.width = '0%'; }
  });
  // reflète l'état de lecture dans la liste des enregistrements
  document.querySelectorAll('.clip-item').forEach(c => c.classList.toggle('playing', playing.has(c.dataset.file)));
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
    if (micNodes.el) micNodes.el.pause();
    if (micNodes.monEl) micNodes.monEl.pause();
    if (micNodes.fx) micNodes.fx.destroy();
    micNodes.ctx.close();
    micNodes = null;
  }
  $('dotMic').style.background = 'var(--text-dim)';
  $('statMic').textContent = 'Micro → Discord : inactif';
  if (!on) return;

  // Le câble virtuel est optionnel : sans lui, on démarre quand même en
  // « mode test » (retour casque seulement) pour écouter les transformations.
  const cableSink = (state.discord.enabled && state.discord.deviceId && state.discord.deviceId !== 'default')
    ? state.discord.deviceId : null;

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
    gain.gain.value = fin(state.mic.gain, 1);

    // Suppresseur de bruit « façon Krisp » — inséré UNIQUEMENT dans la chaîne
    // micro (les sons du soundboard passent ailleurs et ne sont pas filtrés).
    let denoise = null;
    try {
      await ctx.audioWorklet.addModule('../vendor/denoise-processor.js');
      denoise = new AudioWorkletNode(ctx, 'denoise-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      denoise.port.postMessage({ enabled: !!state.mic.denoise, strength: fin(state.mic.denoiseStrength, 0.6) });
    } catch (e) { denoise = null; }

    // Chaîne de modulation de voix insérée entre le gain et les sorties
    const fx = new VoiceFX(ctx);
    await fx.initPitch('../vendor/soundtouch-processor.js');
    fx.applyPreset(currentVoicePreset());
    src.connect(gain);
    if (denoise) { gain.connect(denoise); denoise.connect(fx.input); }
    else gain.connect(fx.input);

    // Sortie 1 (optionnelle) : câble virtuel -> Discord
    let el = null;
    if (cableSink) {
      const dest = ctx.createMediaStreamDestination();
      fx.output.connect(dest);
      el = new Audio();
      el.srcObject = dest.stream;
      await el.setSinkId(cableSink);
      await el.play();
    }

    // Sortie 2 : retour casque de TA voix (pour t'entendre transformé)
    const monDest = ctx.createMediaStreamDestination();
    const monGain = ctx.createGain();
    monGain.gain.value = state.voice.monitor ? fin(state.voice.monitorVol, 0.7) : 0;
    fx.output.connect(monGain);
    monGain.connect(monDest);
    const monEl = new Audio();
    monEl.srcObject = monDest.stream;
    try {
      const sink = state.monitor.deviceId && state.monitor.deviceId !== 'default' ? state.monitor.deviceId : '';
      if (sink) await monEl.setSinkId(sink);
    } catch (e) {}
    await monEl.play();

    micNodes = { stream, ctx, gain, denoise, el, fx, monGain, monEl };
    if (cableSink) {
      $('dotMic').style.background = 'var(--green)';
      $('statMic').textContent = 'Micro → Discord : actif 🎤';
      toast('🎤 Ta voix passe maintenant par le câble virtuel');
    } else {
      $('dotMic').style.background = 'var(--yellow)';
      $('statMic').textContent = 'Micro : test casque (pas envoyé à Discord)';
      toast('🎧 Mode test : active « M\'entendre » pour écouter ta voix transformée');
    }
    updateVoiceStatus();
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

// Applique en direct les réglages du suppresseur de bruit micro (façon Krisp).
// N'agit que sur la chaîne micro -> les sons du soundboard restent intacts.
function applyDenoise() {
  if (micNodes && micNodes.denoise) {
    micNodes.denoise.port.postMessage({
      enabled: !!state.mic.denoise,
      strength: fin(state.mic.denoiseStrength, 0.6),
    });
  }
  const dot = $('dotDenoise');
  if (dot) dot.style.background = state.mic.denoise ? 'var(--green)' : 'var(--text-dim)';
}

// Active/coupe le retour casque de ta voix (effets classiques ; le live IA
// VCClient gère son propre monitor dans sa fenêtre).
function applyVoiceMonitor() {
  if (micNodes && micNodes.monGain) {
    micNodes.monGain.gain.value = state.voice.monitor ? fin(state.voice.monitorVol, 0.7) : 0;
  }
}
function setVoiceMonitor(on) {
  state.voice.monitor = on;
  saveState();
  applyVoiceMonitor();
  updateVoiceStatus();
  // sans le micro actif, il n'y a rien à écouter : on l'active
  // (sauf si le live IA tourne : c'est lui qui tient le micro)
  if (on && !state.mic.enabled && !iaLive) {
    state.mic.enabled = true; $('swMic').checked = true; saveState();
    setMicPassthrough(true);
  }
}

function updateVoiceStatus() {
  const p = currentVoicePreset();
  const dot = $('dotVoice'), stat = $('statVoice');
  if (!dot) return;
  if (iaLive) {
    dot.style.background = 'var(--red)';
    stat.textContent = 'Voix IA : ' + (state.ia.model || 'active') + ' 🔴';
  } else {
    const active = p.id !== 'none';
    dot.style.background = active ? 'var(--blurple)' : 'var(--text-dim)';
    stat.textContent = 'Voix : ' + (active ? p.emoji + ' ' + p.name : 'normale');
  }
  const warn = $('voiceMicWarn');
  if (warn) warn.style.display = (state.mic.enabled || iaLive ? 'none' : 'block');
  const sw = $('swVoiceMon');
  if (sw) sw.checked = state.voice.monitor;
  // griser les effets classiques quand l'IA prend le micro
  const grid = $('voiceGrid');
  if (grid) { grid.style.opacity = iaLive ? '0.4' : '1'; grid.style.pointerEvents = iaLive ? 'none' : ''; }
  // pendant le live IA, le micro appartient à l'IA : toggle verrouillé + statut clair
  const swm = $('swMic');
  if (swm) swm.disabled = iaLive;
  if (iaLive) {
    $('dotMic').style.background = 'var(--blurple)';
    $('statMic').textContent = 'Micro : capturé par le live IA 🧠';
  }
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

/* ================== Voix IA temps réel (VCClient / Beatrice) ================== */
// L'ancienne conversion RVC maison (streaming bloc-par-bloc) grésillait : elle est
// remplacée par VCClient (moteur w-okada, conçu pour le temps réel). Notre app
// se contente de l'installer, le lancer, et guider le routage vers le câble.
let iaLive = false;   // conservé pour updateVoiceStatus (toujours false désormais)
let vcBusy = false;

function vcLog(line) {
  const box = $('vcLog');
  if (!box) return;
  box.style.display = 'block';
  box.textContent += (box.textContent ? '\n' : '') + line;
  box.scrollTop = box.scrollHeight;
}

// Rafraîchit la section IA selon l'état de VCClient (installé / bon moteur / lancé)
async function refreshIaSection() {
  let st;
  try { st = await window.sb.vcclient.status(); }
  catch { st = { installed: false, hasRvc: false, running: false }; }   // ne laisse jamais la section vide
  // "installé" au sens utile = build complète RVC. Une ancienne build Beatrice
  // (sans RVC) est traitée comme "à mettre à niveau".
  const ready = st.installed && st.hasRvc;
  $('vcNotInstalled').style.display = ready ? 'none' : 'block';
  $('vcReady').style.display = ready ? 'block' : 'none';
  // adapte le bouton d'install selon "jamais installé" vs "à mettre à niveau"
  const upgrade = st.installed && !st.hasRvc;
  const btn = $('vcInstallBtn');
  if (btn && !vcBusy) {
    btn.innerHTML = upgrade
      ? '⬆️ Mettre à niveau (voix RVC / françaises)'
      : '📥 Installer le moteur de voix IA';
  }
  const note = $('vcUpgradeNote');
  if (note) note.style.display = upgrade ? 'block' : 'none';
  if (ready) {
    const running = st.running;
    $('vcRunBadge').textContent = running ? 'en marche 🟢' : 'arrêté';
    $('vcRunBadge').className = 'badge ' + (running ? 'ok' : 'ko');
    $('vcLaunchBtn').style.display = running ? 'none' : 'inline-block';
    $('vcStopBtn').style.display = running ? 'inline-block' : 'none';
    $('vcSimple').style.display = running ? 'block' : 'none';
    if (running) { vcUrl = st.url; vcLoadPanel(); } else vcHideEmbed();
  } else {
    $('vcSimple').style.display = 'none';
    vcHideEmbed();
  }
}

/* ----- Panneau Voix IA simplifié : pilote l'API REST du moteur ----- */
let vcUrl = 'http://127.0.0.1:18888/';
let vcSel = null;          // slot de voix sélectionné
let vcConverting = false;  // conversion en cours (boucle audio serveur)
let vcPanelBusy = false;
let vcMicWasOn = false;    // passthrough micro à restaurer après la voix IA

async function vca(path, method = 'GET', body = null) {
  const r = await window.sb.vcclient.api(path, method, body);
  if (!r || r.error) throw new Error((r && r.error) || 'API injoignable');
  return r.data;
}

async function vcLoadPanel() {
  if (vcPanelBusy) return;
  vcPanelBusy = true;
  try {
    const [slots, config, inputs, outputs, gpus, info] = await Promise.all([
      vca('/api/slot-manager/slots'),
      vca('/api/configuration-manager/configuration'),
      vca('/api/audio-device-manager/input_devices'),
      vca('/api/audio-device-manager/output_devices'),
      vca('/api/gpu-device-manager/devices'),
      vca('/api/voice-changer-manager/information'),
    ]);
    vcConverting = !!info.local_voice_changer_interface_active;
    vcSel = config.current_slot_index;

    // Sortie forcée sur CABLE Input (MME) : c'est le micro virtuel que Discord
    // écoute. MME est le seul host API que le moteur ouvre de façon fiable.
    const cable = outputs.find(d => d.host_api === 'MME' && /CABLE Input/i.test(d.name));
    if (cable && config.audio_output_device_index !== cable.index) {
      config.audio_output_device_index = cable.index;
      await vca('/api/configuration-manager/configuration', 'PUT', config);
    }

    // ----- Grille des voix -----
    const grid = $('vcVoices');
    grid.innerHTML = '';
    for (const s of slots.filter(x => x.name)) {
      const el = document.createElement('div');
      el.className = 'vc-voice' + (s.slot_index === vcSel ? ' sel' : '');
      el.dataset.slot = s.slot_index;
      el.title = s.name;
      el.innerHTML = '<span class="vico">🎭</span><span class="vname"></span>';
      el.querySelector('.vname').textContent = s.name;
      el.addEventListener('click', () => vcSelectVoice(s.slot_index));
      grid.appendChild(el);
    }

    // ----- Pitch de la voix courante -----
    const cur = slots.find(x => x.slot_index === vcSel);
    $('vcPitch').value = cur ? Math.round(cur.pitch_shift || 0) : 0;
    $('vcPitchLbl').textContent = $('vcPitch').value;

    // ----- Micro (entrées MME uniquement, les plus compatibles) -----
    const micSel = $('vcMicSel');
    micSel.innerHTML = '';
    for (const d of inputs.filter(x => x.host_api === 'MME' && x.index > 0)) {
      const o = document.createElement('option');
      o.value = d.index; o.textContent = d.name;
      micSel.appendChild(o);
    }
    micSel.value = String(config.audio_input_device_index);
    if (!micSel.value && micSel.options.length) micSel.selectedIndex = 0;

    // ----- Retour casque (sorties MME + aucun) -----
    const monSel = $('vcMonSel');
    monSel.innerHTML = '<option value="-1">— aucun —</option>';
    for (const d of outputs.filter(x => x.host_api === 'MME' && x.index > 0 && !/CABLE/i.test(x.name))) {
      const o = document.createElement('option');
      o.value = d.index; o.textContent = d.name;
      monSel.appendChild(o);
    }
    monSel.value = String(config.audio_monitor_device_index);
    if (!monSel.value) monSel.value = '-1';

    // ----- GPU / CPU -----
    const gpuSel = $('vcGpuSel');
    gpuSel.innerHTML = '';
    for (const g of gpus) {
      const o = document.createElement('option');
      o.value = g.device_id_int;
      o.textContent = g.device_id_int < 0 ? '🐢 Processeur (lent)' : '🚀 ' + g.name;
      gpuSel.appendChild(o);
    }
    gpuSel.value = String(config.gpu_device_id_int);

    vcUpdateConvertBtn();
    if (!cable) $('vcPanelStatus').textContent = '⚠️ CABLE Input introuvable — installe le câble virtuel (réglages)';
  } catch (e) {
    $('vcPanelStatus').textContent = '❌ ' + (e.message || e);
  } finally {
    vcPanelBusy = false;
  }
}

// Change un ou plusieurs champs de la configuration du moteur
async function vcPutConfig(patch) {
  const config = await vca('/api/configuration-manager/configuration');
  Object.assign(config, patch);
  await vca('/api/configuration-manager/configuration', 'PUT', config);
}

async function vcSelectVoice(idx) {
  vcSel = idx;
  document.querySelectorAll('.vc-voice').forEach(v => v.classList.toggle('sel', Number(v.dataset.slot) === idx));
  try {
    await vcPutConfig({ current_slot_index: idx });   // appliqué à chaud, même en direct
    const slot = await vca('/api/slot-manager/slots/' + idx);
    $('vcPitch').value = Math.round(slot.pitch_shift || 0);
    $('vcPitchLbl').textContent = $('vcPitch').value;
    if (vcConverting) $('vcPanelStatus').textContent = '🟢 En direct avec « ' + slot.name + ' »';
  } catch (e) { $('vcPanelStatus').textContent = '❌ ' + e.message; }
}

function vcUpdateConvertBtn() {
  const b = $('vcConvertBtn');
  b.disabled = false;
  b.textContent = vcConverting ? '⏹ Désactiver ma voix IA' : '🎙️ Activer ma voix IA';
  b.classList.toggle('primary', !vcConverting);
  $('vcPanelStatus').textContent = vcConverting ? '🟢 Ta voix IA est en direct — parle !' : '';
}

async function vcToggleConvert() {
  const b = $('vcConvertBtn');
  b.disabled = true;
  try {
    if (!vcConverting) {
      // le moteur prend le micro : on coupe le passthrough classique pour ne pas
      // envoyer AUSSI la voix normale dans le câble
      vcMicWasOn = state.mic.enabled;
      if (state.mic.enabled) {
        state.mic.enabled = false; $('swMic').checked = false; saveState();
        await setMicPassthrough(false);
        toast('🎤 Micro classique coupé (la voix IA le remplace)');
      }
      b.innerHTML = '<span class="spin">⏳</span> Démarrage de la voix…';
      await vca('/api/voice-changer/operation/start_server_device', 'POST');
      // vérifie que la boucle audio est bien partie (le moteur meurt si un périphérique est invalide)
      await new Promise(r => setTimeout(r, 4000));
      const info = await vca('/api/voice-changer-manager/information');
      vcConverting = !!info.local_voice_changer_interface_active;
      if (!vcConverting) throw new Error('le moteur n\'a pas démarré (périphérique audio invalide ?)');
    } else {
      await vca('/api/voice-changer/operation/stop_server_device', 'POST');
      await new Promise(r => setTimeout(r, 1000));
      vcConverting = false;
      if (vcMicWasOn) {
        state.mic.enabled = true; $('swMic').checked = true; saveState();
        await setMicPassthrough(true);
        toast('🎤 Micro classique réactivé');
      }
    }
    vcUpdateConvertBtn();
  } catch (e) {
    vcUpdateConvertBtn();
    $('vcPanelStatus').textContent = '❌ ' + (e.message || e);
    // le moteur est peut-être mort : resynchronise la section
    refreshIaSection();
  }
}

// Interface complète de VCClient embarquée (mode avancé, import de modèles…)
function vcShowEmbed() {
  const box = $('vcEmbed'), view = $('vcFrame');
  box.style.display = 'block';
  $('vcReloadBtn').style.display = 'inline-block';
  $('vcEmbedToggle').textContent = '🖥️ Cacher l\'interface complète';
  if (!view.getAttribute('src') || view.getAttribute('src') === 'about:blank') {
    view.setAttribute('src', vcUrl);
  }
}
function vcHideEmbed() {
  const box = $('vcEmbed'), view = $('vcFrame');
  box.style.display = 'none';
  $('vcReloadBtn').style.display = 'none';
  const t = $('vcEmbedToggle');
  if (t) t.textContent = '🖥️ Afficher l\'interface complète ici';
  if (view.getAttribute('src') !== 'about:blank') view.setAttribute('src', 'about:blank');
}

async function vcInstall() {
  if (vcBusy) return;
  vcBusy = true;
  $('vcInstallBtn').disabled = true;
  $('vcInstallBtn').innerHTML = '<span class="spin">⏳</span> Installation…';
  $('vcLog').style.display = 'block';
  $('vcLog').textContent = '';
  vcLog('Démarrage de l\'installation…');
  const r = await window.sb.vcclient.install();
  vcBusy = false;
  $('vcInstallBtn').disabled = false;
  $('vcInstallBtn').innerHTML = '📥 Installer le moteur de voix IA';
  if (r && r.ok) { toast('✅ Moteur de voix IA installé !'); await refreshIaSection(); }
  else { toast('❌ Échec (voir le journal)', 4000); vcLog('❌ ' + ((r && r.error) || 'Échec')); }
}

async function vcLaunch() {
  if (vcBusy) return;
  vcBusy = true;
  $('vcLaunchBtn').disabled = true;
  $('vcLaunchBtn').innerHTML = '<span class="spin">⏳</span> Démarrage… (jusqu\'à 30 s)';
  $('vcLog').style.display = 'block';
  const r = await window.sb.vcclient.launch();
  vcBusy = false;
  $('vcLaunchBtn').disabled = false;
  $('vcLaunchBtn').innerHTML = '▶️ Lancer le moteur de voix IA';
  if (r && r.ok) {
    toast('🧠 Moteur prêt — choisis ta voix ci-dessous');
    await refreshIaSection();
    $('vcSimple').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    toast('❌ ' + ((r && r.error) || 'Échec du démarrage'), 4500);
    vcLog('❌ ' + ((r && r.error) || 'inconnu'));
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
    // onerror auto-réparant : si l'image ne charge pas (course au démarrage du
    // protocole icon://, verrou fichier…), on retente une fois puis on retombe
    // sur l'emoji — l'icône n'est jamais durablement vide.
    return '<span class="emoji img" data-emoji="' + esc(iconEmojiFallback(ic)) + '" data-hue="' + ic.hue + '">' +
      '<img src="' + esc(window.sb.iconUrl(ic.image)) + '" alt="" loading="eager"></span>';
  }
  const bg = 'linear-gradient(135deg,hsl(' + ic.hue + ',60%,38%),hsl(' + ((ic.hue + 45) % 360) + ',65%,26%))';
  return '<span class="emoji" style="background:' + bg + '">' + ic.emoji + '</span>';
}
function iconEmojiFallback(ic) {
  // emoji « par défaut » d'un son qui a une image custom (si l'image casse)
  return ic.emoji || '🔊';
}
// Branche le repli auto-réparant sur un <img> d'icône (le CSP interdit l'onerror
// inline, donc on l'attache en JS après insertion dans le DOM).
function wireIconFallback(tile) {
  const img = tile.querySelector('.emoji.img img');
  if (!img) return;
  const retry = () => {
    // recharge une fois avec cache-buster (échec transitoire, ex. protocole
    // icon:// pas encore prêt au tout premier rendu au démarrage)
    img.dataset.retried = '1';
    img.src = img.getAttribute('src').split('?')[0] + '?r=' + Date.now();
  };
  const toEmoji = () => {
    const span = img.parentElement;
    if (!span || !span.classList.contains('img')) return;
    const hue = Number(span.dataset.hue) || 0;
    span.classList.remove('img');
    span.style.background = 'linear-gradient(135deg,hsl(' + hue + ',60%,38%),hsl(' + ((hue + 45) % 360) + ',65%,26%))';
    span.textContent = span.dataset.emoji || '🔊';
  };
  const onError = () => { if (!img.dataset.retried) retry(); else toEmoji(); };
  img.addEventListener('error', onError);
  // Filet crucial : l'image a pu ÉCHOUER avant l'attache de l'écouteur (insertion
  // via innerHTML). On vérifie l'état immédiatement, puis à nouveau au tick suivant.
  const check = () => {
    if (img.complete && img.naturalWidth === 0) onError();
  };
  check();
  requestAnimationFrame(check);
  setTimeout(check, 400);   // dernier contrôle après que le protocole soit sûrement prêt
}

// Texte sous le nom : durée + volume individuel s'il diffère de 100 %
function tileMeta(file) {
  const d = durations.has(file) ? fmtDur(durations.get(file)) : '…';
  const v = fin(state.volumes[file], 1);
  return d + (v !== 1 ? ' · 🔊 ' + Math.round(v * 100) + '%' : '');
}

// Badge volume temporaire au centre de la tuile (pendant la molette)
function showVolBadge(tile, file) {
  let b = tile.querySelector('.volb');
  if (!b) { b = document.createElement('div'); b.className = 'volb'; tile.appendChild(b); }
  b.textContent = '🔊 ' + Math.round(fin(state.volumes[file], 1) * 100) + '%';
  b.classList.add('show');
  clearTimeout(b._h);
  b._h = setTimeout(() => b.classList.remove('show'), 900);
  const meta = tile.querySelector('.dur');
  if (meta) meta.textContent = tileMeta(file);
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
    '<div class="dur">' + tileMeta(s.file) + '</div>' +
    '<div class="bar"></div>';
  wireIconFallback(t);
  t.addEventListener('click', (e) => {
    if (e.target.classList.contains('star')) { toggleFav(s); return; }
    if (e.shiftKey) { playSound(s, { localOnly: true }); return; }  // écoute privée
    playSound(s);
  });
  // molette = volume individuel du son
  t.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cur = fin(state.volumes[s.file], 1);
    const next = Math.min(1, Math.max(0, cur + (e.deltaY < 0 ? 0.05 : -0.05)));
    state.volumes[s.file] = Math.round(next * 100) / 100;
    saveState();
    showVolBadge(t, s.file);
  }, { passive: false });
  t.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtx(e, s); });
  // Glisser-déposer vers une autre catégorie
  t.draggable = true;
  t.addEventListener('dragstart', (e) => {
    draggingSound = s.file;
    e.dataTransfer.setData('text/plain', s.file);
    e.dataTransfer.effectAllowed = 'move';
    t.classList.add('dragging');
  });
  t.addEventListener('dragend', () => {
    draggingSound = null;
    t.classList.remove('dragging');
    document.querySelectorAll('.drop-over').forEach(x => x.classList.remove('drop-over'));
  });
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
    if (d) d.textContent = tileMeta(s.file);
    a.src = '';
  };
}

// Déplace un son vers une catégorie ('' = Général) et met à jour les mappings
async function moveSoundTo(file, folder) {
  const cur = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  if (cur === folder) return;
  const r = await window.sb.moveSound(file, folder);
  if (r.ok) {
    remapFile(file, r.file);
    toast('📁 Déplacé vers « ' + (folder || 'Général') + ' »');
    await loadSounds();
  } else toast('❌ ' + (r.error || 'Erreur'));
}

// Un fichier a changé de chemin : favoris, raccourcis, icônes, volumes et stats suivent
function remapFile(oldFile, newFile) {
  const i = state.favs.indexOf(oldFile);
  if (i >= 0) state.favs[i] = newFile;
  for (const k of Object.keys(state.hotkeys)) if (state.hotkeys[k] === oldFile) state.hotkeys[k] = newFile;
  for (const map of [state.icons, state.volumes, state.plays]) {
    if (map[oldFile] != null) { map[newFile] = map[oldFile]; delete map[oldFile]; }
  }
  saveState();
}

// Une catégorie a été renommée : remap de tous les chemins qui la préfixaient
function remapFolderPrefix(oldF, newF) {
  const op = oldF + '/', np = newF + '/';
  state.favs = state.favs.map(f => f.startsWith(op) ? np + f.slice(op.length) : f);
  for (const k of Object.keys(state.hotkeys)) {
    if (state.hotkeys[k].startsWith(op)) state.hotkeys[k] = np + state.hotkeys[k].slice(op.length);
  }
  for (const map of [state.icons, state.volumes, state.plays]) {
    for (const k of Object.keys(map)) {
      if (k.startsWith(op)) { map[np + k.slice(op.length)] = map[k]; delete map[k]; }
    }
  }
  const ci = state.collapsed.indexOf(oldF);
  if (ci >= 0) state.collapsed[ci] = newF;
  saveState();
}

/* ----- Gestion des catégories ----- */
async function catCreate() {
  const n = await askText({ title: '📁 Nouvelle catégorie', sub: 'Un sous-dossier sera créé dans le dossier des sons' });
  if (!n) return;
  const r = await window.sb.createFolder(n);
  if (r.ok) { toast('📁 Catégorie « ' + r.folder + ' » créée — glisse des sons dedans !'); await loadSounds(); }
  else toast('❌ ' + (r.error || 'Erreur'));
}

async function catRename(folder) {
  const cur = folder.split('/').pop();
  const n = await askText({ title: '✏️ Renommer la catégorie', sub: folder, value: cur });
  if (!n || n === cur) return;
  const r = await window.sb.renameFolder(folder, n);
  if (r.ok) {
    remapFolderPrefix(folder, r.folder);
    const oi = state.catOrder.indexOf(folder);
    if (oi >= 0) state.catOrder[oi] = r.folder;   // l'ordre suit le nouveau nom
    toast('📁 Renommée en « ' + r.folder + ' »');
    await loadSounds();
  } else toast('❌ ' + (r.error || 'Erreur'));
}

// Ordre des catégories : ▲ / ▼ sur l'en-tête (mémorisé)
let lastCatOrder = [];   // ordre affiché des catégories nommées (rempli par render)
function catMove(folder, dir) {
  const order = [...lastCatOrder];
  const i = order.indexOf(folder);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  state.catOrder = order;
  saveState();
  render();
}

async function catDelete(folder) {
  const inside = sounds.filter(s => s.folder === folder || s.folder.startsWith(folder + '/')).length;
  const msg = 'Supprimer la catégorie « ' + folder + ' » ?\n' +
    (inside ? 'Ses ' + inside + ' son(s) seront déplacés dans _corbeille (rien n\'est perdu).' : 'Elle est vide.');
  if (!confirm(msg)) return;
  const r = await window.sb.deleteFolder(folder);
  if (r.ok) {
    const p = folder + '/';
    state.favs = state.favs.filter(f => !f.startsWith(p));
    for (const k of Object.keys(state.hotkeys)) if (state.hotkeys[k].startsWith(p)) delete state.hotkeys[k];
    for (const k of Object.keys(state.icons)) {
      if (k.startsWith(p)) { if (state.icons[k].image) window.sb.removeIcon(state.icons[k].image); delete state.icons[k]; }
    }
    for (const map of [state.volumes, state.plays]) {
      for (const k of Object.keys(map)) if (k.startsWith(p)) delete map[k];
    }
    state.collapsed = state.collapsed.filter(f => f !== folder);
    state.catOrder = state.catOrder.filter(f => f !== folder);
    saveState();
    toast('🗑️ Catégorie déplacée dans _corbeille');
    await loadSounds();
    applyGlobalHotkeys();
  } else toast('❌ ' + (r.error || 'Erreur'));
}

// Rend une section (en-tête + grille) déposable pour le drag & drop interne
function attachDrop(el, folder) {
  el.addEventListener('dragover', (e) => {
    if (draggingSound === null) return;
    const cur = draggingSound.includes('/') ? draggingSound.slice(0, draggingSound.lastIndexOf('/')) : '';
    if (cur === folder) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-over');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-over');
  });
  el.addEventListener('drop', (e) => {
    if (draggingSound === null) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-over');
    const file = draggingSound;
    draggingSound = null;
    moveSoundTo(file, folder);
  });
}

function render() {
  const q = norm($('search').value.trim());
  const filtered = q ? sounds.filter(s => norm(s.name).includes(q)) : sounds;
  const c = $('content');
  c.innerHTML = '';

  if (!sounds.length && !folders.length) {
    c.innerHTML = '<div class="empty"><div class="big">📂</div>' +
      'Aucun son pour l\'instant !<br>' +
      'Clique sur <b>➕ Ajouter des sons</b> ou glisse des fichiers MP3/WAV/OGG ici.<br>' +
      '<span style="font-size:12.5px">Tu peux trouver des memes vocaux sur myinstants.com 😉</span></div>';
    return;
  }
  if (q && !filtered.length) {
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

  // tri des sons dans chaque section selon le réglage
  const sortList = (list) => {
    const l = [...list];
    if (state.sort === 'plays') l.sort((a, b) => (state.plays[b.file] || 0) - (state.plays[a.file] || 0) || a.name.localeCompare(b.name, 'fr'));
    else if (state.sort === 'recent') l.sort((a, b) => b.mtime - a.mtime);
    return l; // 'name' : déjà trié par le scan
  };

  const addSection = ({ title, list, folder = null, manageable = false, droppable = false }) => {
    const wrap = document.createElement('section');
    wrap.className = 'cat';
    const collapsed = folder !== null && state.collapsed.includes(folder);
    const hue = folder ? hash(folder) % 360 : null;
    const h = document.createElement('div');
    h.className = 'section-title' + (folder !== null ? ' clickable' : '');
    h.innerHTML =
      (folder !== null ? '<span class="chev">' + (collapsed ? '▸' : '▾') + '</span>' : '') +
      (hue !== null ? '<span class="cat-dot" style="background:hsl(' + hue + ',62%,48%)"></span>' : '') +
      '<span class="cat-name">' + esc(title) + '</span>' +
      '<span class="cat-count">' + list.length + '</span>' +
      (manageable
        ? '<span class="cat-actions">' +
          '<button class="cat-btn" data-cat-act="up" title="Monter la catégorie">▲</button>' +
          '<button class="cat-btn" data-cat-act="down" title="Descendre la catégorie">▼</button>' +
          '<button class="cat-btn" data-cat-act="rename" title="Renommer la catégorie">✏️</button>' +
          '<button class="cat-btn" data-cat-act="delete" title="Supprimer la catégorie">🗑️</button></span>'
        : '');
    wrap.appendChild(h);
    const g = document.createElement('div');
    g.className = 'grid' + (state.view === 'grid' ? '' : ' ' + state.view);
    if (!list.length) {
      g.innerHTML = '<div class="cat-empty">📥 Catégorie vide — glisse des sons ici</div>';
    } else {
      for (const s of sortList(list)) g.appendChild(tileFor(s));
    }
    if (collapsed) g.style.display = 'none';
    wrap.appendChild(g);
    if (folder !== null) {
      // clic sur l'en-tête = replier/déplier (mémorisé)
      h.addEventListener('click', (e) => {
        if (e.target.closest('[data-cat-act]')) return;
        const i = state.collapsed.indexOf(folder);
        if (i >= 0) state.collapsed.splice(i, 1); else state.collapsed.push(folder);
        saveState();
        render();
      });
    }
    if (manageable) {
      h.querySelectorAll('[data-cat-act]').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.catAct;
        if (act === 'up') catMove(folder, -1);
        else if (act === 'down') catMove(folder, 1);
        else if (act === 'rename') catRename(folder);
        else catDelete(folder);
      }));
    }
    if (droppable) attachDrop(wrap, folder);
    c.appendChild(wrap);
  };

  if (favs.length) addSection({ title: '⭐ Favoris', list: favs });

  // Les plus joués (top 6) — dès qu'au moins 3 sons ont été joués
  if (!q) {
    const top = filtered
      .filter(x => (state.plays[x.file] || 0) > 0)
      .sort((a, b) => (state.plays[b.file] || 0) - (state.plays[a.file] || 0))
      .slice(0, 6);
    if (top.length >= 3) addSection({ title: '🔥 Les plus joués', list: top });
  }

  // Cas simple : aucune catégorie -> une seule section plate
  if (!folders.length && [...groups.keys()].every(k => k === '')) {
    addSection({ title: 'Tous les sons', list: groups.get('') || [], folder: '', droppable: !q });
  } else {
    // Union : racine + dossiers du disque (même vides) + dossiers rencontrés
    const all = new Set(['', ...folders, ...groups.keys()]);
    const keys = [...all].filter(f => !q || (groups.get(f) || []).length);
    // racine d'abord, puis l'ordre personnalisé (▲▼), puis alphabétique pour les nouvelles
    const orderIdx = (f) => { const i = state.catOrder.indexOf(f); return i === -1 ? Infinity : i; };
    keys.sort((a, b) => a === '' ? -1 : b === '' ? 1
      : (orderIdx(a) - orderIdx(b)) || a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    lastCatOrder = keys.filter(Boolean);
    for (const f of keys) {
      addSection({
        title: f ? '📁 ' + f : '📁 Général',
        list: groups.get(f) || [],
        folder: f,
        manageable: !!f,
        droppable: !q,
      });
    }
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
    '<div data-act="preview">🎧 Écouter en privé <span style="opacity:.55">(Shift+clic)</span></div>' +
    '<div data-act="fav">' + (isFav ? '💔 Retirer des favoris' : '⭐ Ajouter aux favoris') + '</div>' +
    '<div data-act="icon">🎨 Changer l\'icône</div>' +
    '<div data-act="edit">✂️ Éditer / Découper</div>' +
    '<div data-act="normalize">📊 Normaliser le volume</div>' +
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
  if (act === 'preview') playSound(s, { localOnly: true });
  if (act === 'fav') toggleFav(s);
  if (act === 'icon') openIconEditor(s);
  if (act === 'edit') openAudioEditor(s);
  if (act === 'normalize') normalizeSounds([s.file]);
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
        remapFile(s.file, r.file);
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

/* ================== Normalisation du volume ================== */
// Ramène un ou plusieurs sons au niveau standard (-16 LUFS) via ffmpeg.
async function normalizeSounds(files, opts = {}) {
  if (!files.length) return;
  const st = await window.sb.editor.status();
  if (!st.ready) {
    toast('⬇️ Téléchargement de l\'outil audio (ffmpeg)…', 6000);
    const r = await window.sb.editor.ensure();
    if (!r.ok) { toast('❌ ffmpeg indisponible : ' + (r.error || 'erreur')); return; }
  }
  if (!opts.silent) toast('📊 Normalisation du volume…', 8000);
  let ok = 0, fail = 0;
  for (const f of files) {
    const r = await window.sb.editor.normalize(f);
    if (r.ok) { ok++; durations.delete(f); } else fail++;
  }
  if (!opts.silent || fail) {
    toast(fail ? `📊 ${ok} normalisé(s), ${fail} échec(s)` : `✅ Volume normalisé (${ok} son${ok > 1 ? 's' : ''})`);
  }
  await loadSounds();
}

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

/* ================== Éditeur de découpe audio ================== */
const editState = {
  sound: null,
  buffer: null,     // AudioBuffer décodé
  duration: 0,
  sel: { start: 0, end: 0 },
  ctx: null,        // AudioContext pour l'aperçu
  previewSrc: null, // BufferSource en cours
  raf: null,
};

function fmtTime(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return m + ':' + sec.toFixed(2).padStart(5, '0');
}
function parseTime(str) {
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec((str || '').trim());
  if (!m) return null;
  return (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
}

async function openAudioEditor(s) {
  editState.sound = s;
  $('editName').textContent = '✂️ ' + s.name;
  $('editModal').classList.add('show');

  // ffmpeg dispo ? sinon on affiche l'étape de téléchargement
  const st = await window.sb.editor.status();
  if (!st.ready) {
    $('editSetup').style.display = 'block';
    $('editMain').style.display = 'none';
    return;
  }
  $('editSetup').style.display = 'none';
  $('editMain').style.display = 'block';
  await loadWaveform(s);
}

async function loadWaveform(s) {
  // décode le fichier pour la forme d'onde + l'aperçu
  const resp = await fetch(window.sb.soundUrl(s.file));
  const arr = await resp.arrayBuffer();
  editState.ctx = editState.ctx || new AudioContext();
  editState.buffer = await editState.ctx.decodeAudioData(arr.slice(0));
  editState.duration = editState.buffer.duration;
  editState.sel = { start: 0, end: editState.duration };
  // attend un frame pour que le canvas ait ses dimensions finales
  requestAnimationFrame(() => { drawWaveform(); updateEditUI(); });
}
// redessine si la fenêtre change de taille pendant l'édition
addEventListener('resize', () => {
  if ($('editModal').classList.contains('show') && editState.buffer) {
    drawWaveform(); updateEditUI();
  }
});

function drawWaveform() {
  const canvas = $('waveCanvas');
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const data = editState.buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  const mid = h / 2;
  ctx.strokeStyle = 'rgba(148,155,164,.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    for (let i = 0; i < step; i++) {
      const v = data[x * step + i] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(x + 0.5, mid + min * mid * 0.92);
    ctx.lineTo(x + 0.5, mid + max * mid * 0.92);
  }
  ctx.stroke();
}

function updateEditUI() {
  const wrap = $('waveCanvas').parentElement;
  const w = wrap.clientWidth;
  const { start, end } = editState.sel;
  const dur = editState.duration || 1;
  const xs = (start / dur) * w, xe = (end / dur) * w;
  $('waveRegion').style.left = xs + 'px';
  $('waveRegion').style.width = Math.max(0, xe - xs) + 'px';
  $('handleStart').style.left = xs + 'px';
  $('handleEnd').style.left = xe + 'px';
  if (document.activeElement !== $('editStart')) $('editStart').value = fmtTime(start);
  if (document.activeElement !== $('editEnd')) $('editEnd').value = fmtTime(end);
  $('editDur').textContent = fmtTime(end - start);
}

// glisser des poignées
function dragHandle(which) {
  return (e) => {
    e.preventDefault();
    const wrap = $('waveCanvas').parentElement;
    const rect = wrap.getBoundingClientRect();
    const move = (ev) => {
      const x = Math.min(rect.width, Math.max(0, (ev.clientX ?? ev.touches?.[0]?.clientX) - rect.left));
      const t = (x / rect.width) * editState.duration;
      if (which === 'start') editState.sel.start = Math.min(t, editState.sel.end - 0.05);
      else editState.sel.end = Math.max(t, editState.sel.start + 0.05);
      updateEditUI();
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
}
$('handleStart').addEventListener('mousedown', dragHandle('start'));
$('handleEnd').addEventListener('mousedown', dragHandle('end'));

// saisie manuelle des temps
$('editStart').addEventListener('change', () => {
  const t = parseTime($('editStart').value);
  if (t != null) { editState.sel.start = Math.min(Math.max(0, t), editState.sel.end - 0.05); }
  updateEditUI();
});
$('editEnd').addEventListener('change', () => {
  const t = parseTime($('editEnd').value);
  if (t != null) { editState.sel.end = Math.max(Math.min(editState.duration, t), editState.sel.start + 0.05); }
  updateEditUI();
});

// fondus
function bindFade(id, lbl) {
  $(id).addEventListener('input', () => { $(lbl).textContent = $(id).value + ' ms'; });
}
bindFade('editFadeIn', 'editFadeInLbl');
bindFade('editFadeOut', 'editFadeOutLbl');

// aperçu de la sélection
function stopPreview() {
  if (editState.previewSrc) { try { editState.previewSrc.stop(); } catch {} editState.previewSrc = null; }
  if (editState.raf) { cancelAnimationFrame(editState.raf); editState.raf = null; }
  $('waveCursor').style.display = 'none';
  $('editPlay').textContent = '▶️ Écouter la sélection';
}
$('editPlay').addEventListener('click', () => {
  if (editState.previewSrc) { stopPreview(); return; }
  const { start, end } = editState.sel;
  const src = editState.ctx.createBufferSource();
  src.buffer = editState.buffer;
  src.connect(editState.ctx.destination);
  const t0 = editState.ctx.currentTime;
  src.start(0, start, end - start);
  editState.previewSrc = src;
  $('editPlay').textContent = '⏹ Arrêter';
  src.onended = stopPreview;
  const wrap = $('waveCanvas').parentElement;
  const cur = $('waveCursor');
  cur.style.display = 'block';
  const tick = () => {
    const played = editState.ctx.currentTime - t0;
    const pos = start + played;
    cur.style.left = (pos / editState.duration) * wrap.clientWidth + 'px';
    if (pos < end) editState.raf = requestAnimationFrame(tick);
  };
  tick();
});

// téléchargement de ffmpeg
$('editEnsureBtn').addEventListener('click', async () => {
  $('editEnsureBtn').disabled = true;
  $('editEnsureBtn').innerHTML = '<span class="spin">⏳</span> Téléchargement…';
  $('editSetupLog').style.display = 'block';
  $('editSetupLog').textContent = '';
  const r = await window.sb.editor.ensure();
  if (r && r.ok) {
    $('editSetup').style.display = 'none';
    $('editMain').style.display = 'block';
    await loadWaveform(editState.sound);
  } else {
    $('editEnsureBtn').disabled = false;
    $('editEnsureBtn').innerHTML = '🔁 Réessayer';
    $('editSetupLog').textContent += '\n❌ ' + ((r && r.error) || 'Échec');
  }
});
window.sb.editor.onLog((line) => {
  const box = $('editSetupLog');
  box.style.display = 'block';
  box.textContent += (box.textContent ? '\n' : '') + line;
  box.scrollTop = box.scrollHeight;
});

// enregistrement
async function doTrim(replace) {
  const s = editState.sound;
  const { start, end } = editState.sel;
  if (!(end > start)) { toast('⚠️ Sélection vide'); return; }
  $('editWorking').style.display = 'block';
  $('editSaveCopy').disabled = $('editSaveReplace').disabled = true;
  stopPreview();
  const r = await window.sb.editor.trim(s.file, {
    start, end,
    fadeIn: (+$('editFadeIn').value) / 1000,
    fadeOut: (+$('editFadeOut').value) / 1000,
    replace,
  });
  $('editWorking').style.display = 'none';
  $('editSaveCopy').disabled = $('editSaveReplace').disabled = false;
  if (r && r.ok) {
    if (replace) {
      // le fichier a le même chemin : on efface sa durée/cache
      durations.delete(s.file);
    } else {
      remapFileCopyMeta(s.file, r.file);
    }
    toast('✂️ ' + (replace ? 'Son remplacé' : 'Copie créée') + ' !');
    closeAudioEditor();
    await loadSounds();
  } else {
    toast('❌ ' + ((r && r.error) || 'Échec de la découpe'), 4000);
  }
}
$('editSaveReplace').addEventListener('click', () => doTrim(true));
$('editSaveCopy').addEventListener('click', () => doTrim(false));

// pour une copie : hérite icône + volume du son d'origine (pas les favoris/raccourcis)
function remapFileCopyMeta(oldFile, newFile) {
  if (state.icons[oldFile]) state.icons[newFile] = { ...state.icons[oldFile], image: undefined };
  if (state.volumes[oldFile] != null) state.volumes[newFile] = state.volumes[oldFile];
  saveState();
}

function closeAudioEditor() {
  stopPreview();
  $('editModal').classList.remove('show');
  editState.sound = null;
  editState.buffer = null;
}
$('editClose').addEventListener('click', closeAudioEditor);
$('editModal').addEventListener('mousedown', (e) => { if (e.target.id === 'editModal') closeAudioEditor(); });

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
  // L'éditeur de découpe est ouvert : Échap ferme, Espace = aperçu
  if ($('editModal').classList.contains('show')) {
    if (['INPUT'].includes(e.target.tagName)) return;
    if (e.key === 'Escape') closeAudioEditor();
    else if (e.key === ' ') { e.preventDefault(); $('editPlay').click(); }
    return;
  }
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
  if (e.key === 'Escape') {
    // priorité : fermer le lecteur vidéo, puis le tiroir des réglages
    if ($('vidPlayer') && $('vidPlayer').style.display !== 'none') { closeVideoPlayer(); return; }
    if ($('settings').classList.contains('open')) { $('settings').classList.remove('open'); return; }
    stopAll(); return;
  }

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
  const [snds, flds] = await Promise.all([window.sb.listSounds(), window.sb.listFolders()]);
  sounds = Array.isArray(snds) ? snds : [];
  folders = Array.isArray(flds) ? flds : [];
  $('statApp').textContent = 'Application prête · ' + sounds.length + ' son' + (sounds.length > 1 ? 's' : '');
  render();
  if ($('replayView') && $('replayView').style.display === 'block') renderClips();
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
  if (state.normalizeImport && r.files?.length) normalizeSounds(r.files);
  if (!r.ok && !r.fail) toast('Aucun fichier ajouté');
}

$('btnAdd').addEventListener('click', async () => {
  const r = await window.sb.pickFiles();
  reportImport(r);
  await loadSounds();
});

let dragDepth = 0;
const iconModalOpen = () => $('iconModal').classList.contains('show');
addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (iconModalOpen() || draggingSound !== null) return; // drag interne : pas d'overlay d'import
  if (++dragDepth === 1) $('dropOverlay').classList.add('show');
});
addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (iconModalOpen() || draggingSound !== null) return;
  if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.remove('show'); }
});
addEventListener('dragover', (e) => {
  if (draggingSound !== null) {
    // drag interne : seules les sections gèrent le dépôt ; ailleurs, interdit
    if (!e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; }
    return;
  }
  e.preventDefault();
});
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').classList.remove('show');
  if (iconModalOpen() || draggingSound !== null) return; // drag interne géré par les sections
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
bindSwitch('swNorm', () => state.normalizeImport, v => state.normalizeImport = v);
bindSwitch('swMic', () => state.mic.enabled, v => {
  if (iaLive) {
    // le live IA tient le micro : réactiver le passthrough enverrait ta voix brute
    // dans le câble en plus de la voix convertie (on l'entendrait « normale »)
    toast('⚠️ Le live IA utilise déjà ton micro — il sera rendu à l\'arrêt du live');
    $('swMic').checked = false;
    return;
  }
  state.mic.enabled = v;
  setMicPassthrough(v);
});
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

// Filtre anti-bruit micro (façon Krisp)
bindSwitch('swDenoise', () => state.mic.denoise, v => {
  state.mic.denoise = v;
  $('denoiseOpts').style.display = v ? 'block' : 'none';
  applyDenoise();
});
$('denoiseOpts').style.display = state.mic.denoise ? 'block' : 'none';
bindVol('denoiseStrength', 'denoiseStrengthLbl', () => fin(state.mic.denoiseStrength, 0.6),
  v => { state.mic.denoiseStrength = v; applyDenoise(); });

$('btnSettings').addEventListener('click', () => $('settings').classList.toggle('open'));
$('settingsClose').addEventListener('click', () => $('settings').classList.remove('open'));

/* ----- Densité d'affichage des sons (grille / compact / liste) ----- */
const VIEWS = { grid: '▦', compact: '▤', list: '☰' };
function applyViewBtn() { $('viewBtn').textContent = VIEWS[state.view] || '▦'; }
$('viewBtn').addEventListener('click', () => {
  const order = Object.keys(VIEWS);
  state.view = order[(order.indexOf(state.view) + 1) % order.length];
  saveState();
  applyViewBtn();
  render();
});
applyViewBtn();

/* ----- Checklist premier lancement ----- */
async function renderOnboard() {
  const box = $('onboard');
  const ob = state.onboard;
  if (ob.dismissed) { box.style.display = 'none'; return; }
  let cableOk = false;
  try { cableOk = (await window.sb.cable.status()).installed; } catch {}
  const played = Object.keys(state.plays).length > 0;
  const allDone = cableOk && ob.discordDone && played;
  box.style.display = allDone ? 'none' : 'block';
  if (allDone) return;
  $('obCable').classList.toggle('done', cableOk);
  $('obDiscord').classList.toggle('done', ob.discordDone);
  $('obPlay').classList.toggle('done', played);
}
$('onboardClose').addEventListener('click', () => {
  state.onboard.dismissed = true; saveState();
  $('onboard').style.display = 'none';
});
$('obDiscordDone').addEventListener('click', () => {
  state.onboard.discordDone = true; saveState();
  renderOnboard();
});
$('btnStop').addEventListener('click', () => stopAll());
$('btnRandom').addEventListener('click', () => { if (sounds.length) playSound(sounds[Math.floor(Math.random() * sounds.length)]); });
$('btnNewCat').addEventListener('click', catCreate);

// Recherche avec bouton ✕
function updateSearchClear() {
  $('searchClear').style.display = $('search').value ? 'grid' : 'none';
}
$('search').addEventListener('input', () => { updateSearchClear(); render(); });
$('searchClear').addEventListener('click', () => {
  $('search').value = '';
  updateSearchClear();
  render();
  $('search').focus();
});
updateSearchClear();

// Tri des sons
$('sortSel').value = state.sort;
$('sortSel').addEventListener('change', (e) => {
  state.sort = e.target.value;
  saveState();
  render();
});

// Import depuis une URL directe
$('btnUrl').addEventListener('click', async () => {
  const url = await askText({
    title: '🌐 Importer depuis une URL',
    sub: 'Lien direct vers un fichier audio (.mp3, .wav…) — ex. myinstants.com',
    value: '',
  });
  if (!url) return;
  toast('⬇️ Téléchargement…');
  const r = await window.sb.importUrl(url);
  if (r.ok) {
    toast('✅ « ' + r.file + ' » ajouté !');
    await loadSounds();
    if (state.normalizeImport) normalizeSounds([r.file]);
  } else toast('❌ ' + (r.error || 'Échec du téléchargement'), 4200);
});
$('testDiscord').addEventListener('click', () => {
  if (!state.discord.deviceId || state.discord.deviceId === 'default') { toast('⚠️ Choisis d\'abord CABLE Input'); return; }
  beep(state.discord.deviceId, state.discord.volume);
  toast('🎵 Bip envoyé — quelqu\'un dans le vocal doit l\'entendre');
});
$('rescanDevices').addEventListener('click', (e) => { e.preventDefault(); refreshDevices().then(render); toast('↻ Périphériques rafraîchis'); });
$('bannerInstall').addEventListener('click', offerCableInstall);
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
/* ================== Onglet Dire (TTS) ================== */
// Voix Edge TTS proposées (gratuites, qualité neurale)
const TTS_VOICES = [
  ['🇫🇷 Français', [
    ['fr-FR-DeniseNeural', 'Denise (femme)'],
    ['fr-FR-HenriNeural', 'Henri (homme)'],
    ['fr-FR-EloiseNeural', 'Éloïse (enfant)'],
    ['fr-FR-VivienneMultilingualNeural', 'Vivienne (multilingue)'],
    ['fr-FR-RemyMultilingualNeural', 'Rémy (multilingue)'],
  ]],
  ['🇨🇦 Québécois', [
    ['fr-CA-SylvieNeural', 'Sylvie'],
    ['fr-CA-AntoineNeural', 'Antoine'],
    ['fr-CA-JeanNeural', 'Jean'],
  ]],
  ['🇧🇪 Belge / 🇨🇭 Suisse', [
    ['fr-BE-CharlineNeural', 'Charline (BE)'],
    ['fr-BE-GerardNeural', 'Gérard (BE)'],
    ['fr-CH-ArianeNeural', 'Ariane (CH)'],
    ['fr-CH-FabriceNeural', 'Fabrice (CH)'],
  ]],
  ['🌍 Autres langues', [
    ['en-US-AriaNeural', 'Aria (anglais US)'],
    ['en-US-GuyNeural', 'Guy (anglais US)'],
    ['en-GB-RyanNeural', 'Ryan (anglais GB)'],
    ['de-DE-KatjaNeural', 'Katja (allemand)'],
    ['es-ES-ElviraNeural', 'Elvira (espagnol)'],
    ['it-IT-DiegoNeural', 'Diego (italien)'],
    ['ja-JP-NanamiNeural', 'Nanami (japonais)'],
  ]],
];
let ttsLast = null;    // { data: ArrayBuffer, text } — dernière synthèse (pour « Garder »)
let ttsBusy = false;

function ttsVoiceLabel(id) {
  for (const [, list] of TTS_VOICES) for (const [v, label] of list) if (v === id) return label;
  return id;
}
{
  const sel = $('ttsVoice');
  for (const [group, list] of TTS_VOICES) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const [v, label] of list) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = state.tts.voice;
  if (!sel.value) sel.value = 'fr-FR-DeniseNeural';
  sel.addEventListener('change', () => { state.tts.voice = sel.value; saveState(); });

  const rate = $('ttsRate'), rateLbl = $('ttsRateLbl');
  rate.value = Math.round(fin(state.tts.rate, 1) * 100);
  rateLbl.textContent = rate.value + '%';
  rate.addEventListener('input', () => {
    rateLbl.textContent = rate.value + '%';
    state.tts.rate = rate.value / 100; saveState();
  });
  const pitch = $('ttsPitch'), pitchLbl = $('ttsPitchLbl');
  pitch.value = fin(state.tts.pitch, 0);
  pitchLbl.textContent = pitch.value;
  pitch.addEventListener('input', () => {
    pitchLbl.textContent = pitch.value;
    state.tts.pitch = Number(pitch.value); saveState();
  });
}

function ttsStatus(msg, isError = false) {
  const el = $('ttsStatus');
  el.textContent = msg;
  el.style.color = isError ? 'var(--red)' : '';
}

/* ----- Pont TTS -> Voix IA (faire dire la phrase par Macron, JDG…) ----- */
let ttsAiNames = {};      // slot_index -> nom de la voix IA
let ttsDecodeCtx = null;  // AudioContext 48 kHz dédié au décodage

// Remplit le sélecteur « Puis convertir en… » avec les voix du moteur (s'il tourne)
async function refreshTtsAi() {
  const sel = $('ttsAiVoice');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— personne (voix TTS pure) —</option>';
  ttsAiNames = {};
  try {
    const st = await window.sb.vcclient.status();
    if (!st.running) {
      const o = document.createElement('option');
      o.disabled = true;
      o.textContent = '🧠 (lance le moteur dans l\'onglet Voix)';
      sel.appendChild(o);
      return;
    }
    const slots = await vca('/api/slot-manager/slots');
    for (const s of slots.filter(x => x.name)) {
      ttsAiNames[s.slot_index] = s.name;
      const o = document.createElement('option');
      o.value = s.slot_index;
      o.textContent = '🎭 ' + s.name;
      sel.appendChild(o);
    }
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  } catch {}
}

// MP3 du TTS -> float32 48 kHz -> moteur IA -> WAV converti
// (le moteur renvoie du float32 mono au même sample rate)
async function ttsConvertAi(mp3Data, slotIndex) {
  if (!ttsDecodeCtx) ttsDecodeCtx = new AudioContext({ sampleRate: 48000 });
  const bytes = new Uint8Array(mp3Data);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const buf = await ttsDecodeCtx.decodeAudioData(ab);
  const f32 = buf.getChannelData(0);
  const r = await window.sb.vcclient.convert(f32.buffer, { slot: slotIndex, sampleRate: 48000 });
  if (!r || !r.ok) throw new Error((r && r.error) || 'Conversion IA échouée');
  const out = new Uint8Array(r.data);
  const samples = new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  return encodeWav(samples, 48000);
}

// Synthétise (+ conversion voix IA optionnelle) puis joue (Discord + casque)
async function ttsSay(text, { localOnly = false, voice = null, ai = undefined } = {}) {
  text = String(text || '').trim();
  if (!text) { $('ttsText').focus(); return; }
  if (ttsBusy) return;
  ttsBusy = true;
  ttsStatus('🎙 Synthèse en cours…');
  try {
    const v = voice || state.tts.voice;
    // ai : undefined = suivre le sélecteur ; null = aucune ; nombre = slot IA
    const aiSlot = ai !== undefined ? ai : ($('ttsAiVoice').value === '' ? null : Number($('ttsAiVoice').value));
    const r = await window.sb.tts.speak(text, { voice: v, rate: state.tts.rate, pitch: state.tts.pitch });
    if (!r.ok) { ttsStatus('❌ ' + (r.error || 'Synthèse échouée'), true); return; }

    let playData = r.data, mime = 'audio/mpeg', ext = 'mp3';
    if (aiSlot != null && Number.isFinite(aiSlot)) {
      ttsStatus('🧠 Conversion avec la voix de ' + (ttsAiNames[aiSlot] || 'l\'IA') + '…');
      playData = await ttsConvertAi(r.data, aiSlot);
      mime = 'audio/wav'; ext = 'wav';
    }
    ttsLast = { data: playData, text, ext };
    $('ttsKeep').disabled = false;

    const blob = new Blob([playData], { type: mime });
    const url = URL.createObjectURL(blob);
    const jobs = [];
    if (!localOnly && state.discord.enabled && state.discord.deviceId && state.discord.deviceId !== 'default') {
      jobs.push(spawnAudio(url, state.discord.deviceId, state.discord.volume, '__tts__'));
    }
    if (state.monitor.enabled || localOnly) {
      const mv = localOnly ? Math.max(state.monitor.volume, 0.5) : state.monitor.volume;
      jobs.push(spawnAudio(url, state.monitor.deviceId, mv, '__tts__'));
    }
    if (!jobs.length) { ttsStatus('⚠️ Aucune sortie active — vérifie les réglages ⚙️', true); return; }
    ttsStatus((localOnly ? '🎧 Lecture en privé' : '📢 Dit dans Discord !')
      + (aiSlot != null ? ' (voix de ' + (ttsAiNames[aiSlot] || 'l\'IA') + ')' : ''));
    ttsAddHistory(text, v, aiSlot, aiSlot != null ? ttsAiNames[aiSlot] : null);
    Promise.all(jobs).finally(() => setTimeout(() => URL.revokeObjectURL(url), 60000));
  } catch (e) {
    ttsStatus('❌ ' + (e.message || e), true);
  } finally {
    ttsBusy = false;
  }
}

function ttsAddHistory(text, voice, ai = null, aiName = null) {
  const h = state.tts.history;
  const i = h.findIndex(x => x.text === text && x.voice === voice && (x.ai ?? null) === (ai ?? null));
  let item = i >= 0 ? h.splice(i, 1)[0] : { text, voice, ai, aiName, fav: false };
  h.unshift(item);
  // limite : 30 entrées non-favorites (les ⭐ sont gardées)
  let n = 0;
  state.tts.history = h.filter(x => x.fav || ++n <= 30);
  saveState();
  renderTtsHistory();
}

function renderTtsHistory() {
  const box = $('ttsHistory');
  box.innerHTML = '';
  // favoris d'abord, puis le reste dans l'ordre chronologique
  const items = [...state.tts.history.filter(x => x.fav), ...state.tts.history.filter(x => !x.fav)];
  if (!items.length) {
    box.innerHTML = '<div class="clips-empty">Tes phrases apparaîtront ici.<br>⭐ = épinglée (gardée pour toujours)</div>';
    return;
  }
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'tts-item' + (it.fav ? ' fav' : '');
    el.title = it.text;
    el.innerHTML =
      '<span class="txt"></span><span class="who">' + esc(ttsVoiceLabel(it.voice)) +
      (it.aiName ? ' → 🧠 ' + esc(it.aiName) : '') + '</span>' +
      '<span class="acts">' +
        '<button data-tts-act="fav" title="' + (it.fav ? 'Désépingler' : 'Épingler') + '">' + (it.fav ? '⭐' : '☆') + '</button>' +
        '<button data-tts-act="del" title="Retirer">✕</button>' +
      '</span>';
    el.querySelector('.txt').textContent = it.text;
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-tts-act]')?.dataset.ttsAct;
      if (act === 'fav') {
        it.fav = !it.fav; saveState(); renderTtsHistory(); return;
      }
      if (act === 'del') {
        state.tts.history = state.tts.history.filter(x => x !== it);
        saveState(); renderTtsHistory(); return;
      }
      $('ttsText').value = it.text;
      ttsSay(it.text, { voice: it.voice, ai: it.ai ?? null });
    });
    box.appendChild(el);
  }
}

$('ttsSay').addEventListener('click', () => ttsSay($('ttsText').value));
$('ttsPreview').addEventListener('click', () => ttsSay($('ttsText').value, { localOnly: true }));
$('ttsText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ttsSay($('ttsText').value); }
});
$('ttsKeep').addEventListener('click', async () => {
  if (!ttsLast) return;
  const r = await window.sb.tts.save(ttsLast.data, ttsLast.text, ttsLast.ext || 'mp3');
  if (r.ok) { toast('✅ Gardé dans la catégorie « TTS » !'); await loadSounds(); }
  else toast('❌ ' + (r.error || 'Erreur'));
});
$('ttsClear').addEventListener('click', () => {
  state.tts.history = state.tts.history.filter(x => x.fav);
  saveState(); renderTtsHistory();
});

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const isSounds = tab === 'sounds';
  $('content').style.display = isSounds ? '' : 'none';
  if (isSounds) renderOnboard(); else $('onboard').style.display = 'none';
  $('voiceView').style.display = tab === 'voice' ? 'block' : 'none';
  $('replayView').style.display = tab === 'replay' ? 'block' : 'none';
  $('ttsView').style.display = tab === 'tts' ? 'block' : 'none';
  $('guideView').style.display = tab === 'guide' ? 'block' : 'none';
  // les contrôles de la barre du haut ne concernent que l'onglet Sons
  $('searchWrap').style.visibility = isSounds ? '' : 'hidden';
  for (const id of ['sortSel', 'viewBtn', 'btnRandom', 'btnAdd', 'btnUrl', 'btnNewCat']) {
    $(id).style.display = isSounds ? '' : 'none';
  }
  if (tab === 'voice') { renderVoice(); updateVoiceStatus(); refreshIaSection(); }
  if (tab === 'replay') { refreshReplayTab(); setReplayMode(state.replay.mode || 'audio'); }
  if (tab === 'tts') { renderTtsHistory(); refreshTtsAi(); $('ttsText').focus(); }
  if (tab === 'guide') renderGuideKeys();
}

// Liste dynamique des touches assignées aux sons (onglet Guide)
function renderGuideKeys() {
  const box = $('guideKeys');
  const entries = Object.entries(state.hotkeys);
  if (!entries.length) {
    box.innerHTML = '<div class="hint">Aucune touche assignée pour l\'instant — clic droit sur un son → « Assigner une touche ».</div>';
    return;
  }
  box.innerHTML = '';
  for (const [acc, file] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = sounds.find(x => x.file === file);
    const div = document.createElement('div');
    div.className = 'gk';
    const keys = acc.split('+').map(k => '<kbd>' + esc(k) + '</kbd>').join('+');
    div.innerHTML = '<span>' + keys + '</span>';
    const name = document.createElement('span');
    name.textContent = s ? s.name : file;
    div.appendChild(name);
    box.appendChild(div);
  }
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
$('voiceEnableMic').addEventListener('click', () => {
  state.mic.enabled = true; $('swMic').checked = true; saveState();
  setMicPassthrough(true);
  updateVoiceStatus();
});
$('swVoiceMon').addEventListener('change', (e) => setVoiceMonitor(e.target.checked));
// Volume du retour casque (appliqué en direct aux deux modes : effets et IA)
(() => {
  const el = $('volVoiceMon'), lbl = $('volVoiceMonLbl');
  el.value = Math.round(fin(state.voice.monitorVol, 0.7) * 100);
  lbl.textContent = el.value + '%';
  el.addEventListener('input', () => {
    lbl.textContent = el.value + '%';
    state.voice.monitorVol = el.value / 100;
    saveState();
    applyVoiceMonitor();
  });
})();

/* ----- Bindings Voix IA (VCClient) ----- */
$('vcInstallBtn').addEventListener('click', vcInstall);
$('vcLaunchBtn').addEventListener('click', vcLaunch);
$('vcOpenBtn').addEventListener('click', () => window.sb.vcclient.openUI());
$('vcReloadBtn').addEventListener('click', () => { try { $('vcFrame').reload(); } catch {} });
$('vcEmbedToggle').addEventListener('click', () => {
  $('vcEmbed').style.display === 'none' ? vcShowEmbed() : vcHideEmbed();
});
$('vcConvertBtn').addEventListener('click', vcToggleConvert);
$('vcPitch').addEventListener('input', () => { $('vcPitchLbl').textContent = $('vcPitch').value; });
$('vcPitch').addEventListener('change', async () => {
  if (vcSel == null) return;
  try {
    const slot = await vca('/api/slot-manager/slots/' + vcSel);
    slot.pitch_shift = Number($('vcPitch').value);
    await vca('/api/slot-manager/slots/' + vcSel, 'PUT', slot);
  } catch (e) { $('vcPanelStatus').textContent = '❌ ' + e.message; }
});
$('vcMicSel').addEventListener('change', () => vcPutConfig({ audio_input_device_index: Number($('vcMicSel').value) }).catch(e => $('vcPanelStatus').textContent = '❌ ' + e.message));
$('vcMonSel').addEventListener('change', () => vcPutConfig({ audio_monitor_device_index: Number($('vcMonSel').value) }).catch(e => $('vcPanelStatus').textContent = '❌ ' + e.message));
$('vcGpuSel').addEventListener('change', () => vcPutConfig({ gpu_device_id_int: Number($('vcGpuSel').value) }).catch(e => $('vcPanelStatus').textContent = '❌ ' + e.message));
$('vcStopBtn').addEventListener('click', async () => {
  await window.sb.vcclient.stop();
  toast('⏹ Moteur de voix IA arrêté');
  await refreshIaSection();
});
window.sb.vcclient.onLog((line) => vcLog(line));

/* ================== Assistant d'installation du câble ================== */
let cableInstalling = false;

function setupLog(line) {
  const box = $('setupLog');
  box.textContent += (box.textContent ? '\n' : '') + line;
  box.scrollTop = box.scrollHeight;
}
window.sb.cable.onLog((line) => setupLog(line));

function openSetup() { $('setupModal').classList.add('show'); }
function closeSetup() { $('setupModal').classList.remove('show'); }

async function runCableInstall() {
  if (cableInstalling) return;
  cableInstalling = true;
  $('setupInstallBtn').disabled = true;
  $('setupInstallBtn').innerHTML = '<span class="spin">⏳</span> Installation en cours…';
  $('setupLater').style.display = 'none';
  $('setupSteps').style.display = 'block';
  $('setupLog').textContent = '';

  const r = await window.sb.cable.install();
  cableInstalling = false;

  if (r && r.ok) {
    // succès : propose le redémarrage
    $('setupInstallBtn').style.display = 'none';
    $('setupReboot').style.display = 'block';
    $('setupRebootBtn').style.display = 'inline-block';
    $('setupLater').style.display = 'inline-block';
    $('setupLater').textContent = 'Redémarrer plus tard';
    refreshDevices().then(render);
  } else {
    // échec / annulation : on peut réessayer
    $('setupInstallBtn').disabled = false;
    $('setupInstallBtn').innerHTML = '🔁 Réessayer l\'installation';
    $('setupLater').style.display = 'inline-block';
    setupLog('❌ ' + ((r && r.error) || 'Échec') + '\nTu peux réessayer, ou installer manuellement (lien ci-dessous).');
  }
}

$('setupInstallBtn').addEventListener('click', runCableInstall);
$('setupRebootBtn').addEventListener('click', () => {
  $('setupRebootBtn').disabled = true;
  $('setupRebootBtn').innerHTML = '<span class="spin">🔄</span> Redémarrage…';
  window.sb.cable.reboot();
});
$('setupLater').addEventListener('click', () => {
  localStorage.setItem('sb-setup-dismissed', '1');
  closeSetup();
});

// Bouton de la bannière : rouvre l'assistant plutôt qu'un simple lien
function offerCableInstall() { openSetup(); }

/* ================== Export / import de la bibliothèque ================== */
// Réglages partageables (pas les périphériques audio, propres à chaque machine)
function shareableManifest() {
  return {
    version: 1,
    icons: state.icons,
    favs: state.favs,
    hotkeys: state.hotkeys,
    volumes: state.volumes,
    plays: state.plays,
    collapsed: state.collapsed,
  };
}
/* ================== Thème de couleur ================== */
// nom -> [couleur de pastille, libellé]
const THEMES = {
  discord:   ['#5865f2', 'Discord (défaut)'],
  ocean:     ['#339af0', 'Océan'],
  turquoise: ['#15aabf', 'Turquoise'],
  emeraude:  ['#12b886', 'Émeraude'],
  or:        ['#f59f00', 'Or'],
  sunset:    ['#f76707', 'Coucher de soleil'],
  rouge:     ['#f03e3e', 'Rouge'],
  rose:      ['#e64980', 'Rose'],
  amoled:    ['#000000', 'AMOLED (noir profond)'],
};
function applyTheme() {
  const t = THEMES[state.theme] ? state.theme : 'discord';
  if (t === 'discord') delete document.body.dataset.theme;
  else document.body.dataset.theme = t;
  document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('sel', d.dataset.theme === t));
}
{
  const row = $('themeRow');
  for (const [name, [color, label]] of Object.entries(THEMES)) {
    const d = document.createElement('div');
    d.className = 'theme-dot';
    d.dataset.theme = name;
    d.title = label;
    d.style.background = name === 'amoled'
      ? 'linear-gradient(135deg,#000 50%,#5865f2 50%)' : color;
    d.addEventListener('click', () => { state.theme = name; saveState(); applyTheme(); });
    row.appendChild(d);
  }
  applyTheme();
}

$('btnExport').addEventListener('click', async () => {
  toast('📦 Préparation de l\'export…');
  const r = await window.sb.exportConfig(shareableManifest());
  if (r.ok) toast('✅ Bibliothèque exportée !');
  else if (!r.canceled) toast('❌ ' + (r.error || 'Échec de l\'export'), 4000);
});
$('btnImport').addEventListener('click', async () => {
  if (!confirm('Importer une bibliothèque ?\nSes sons et icônes s\'ajouteront à la tienne (rien n\'est écrasé).')) return;
  toast('📥 Import en cours…');
  const r = await window.sb.importConfig();
  if (r.canceled) return;
  if (!r.ok) { toast('❌ ' + (r.error || 'Échec de l\'import'), 4000); return; }
  const m = r.manifest || {};
  const remap = r.remap || {};
  // recale les icônes/favoris/volumes du manifest sur les nouveaux chemins de fichiers
  const map = (oldF) => remap[oldF] || oldF;
  if (m.icons) for (const [f, ic] of Object.entries(m.icons)) if (!state.icons[map(f)]) state.icons[map(f)] = ic;
  if (m.volumes) for (const [f, v] of Object.entries(m.volumes)) if (state.volumes[map(f)] == null) state.volumes[map(f)] = v;
  if (Array.isArray(m.favs)) for (const f of m.favs) { const n = map(f); if (!state.favs.includes(n)) state.favs.push(n); }
  saveState();
  await loadSounds();
  toast('✅ ' + (r.added || 0) + ' son(s) importé(s) !', 3500);
});

/* ================== Visualiseur audio (VU-mètre + waveform) ================== */
let vizCtx = null, vizAnalyser = null, vizStream = null, vizRaf = null, vizEl = null;

async function startViz() {
  stopViz();
  const source = $('vizSource').value;
  try {
    vizCtx = new AudioContext();
    let node;
    if (source === 'mic') {
      const devId = state.mic.deviceId && state.mic.deviceId !== 'default' ? { exact: state.mic.deviceId } : undefined;
      vizStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: devId, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      node = vizCtx.createMediaStreamSource(vizStream);
    } else {
      // « Sortie Discord » : on écoute CABLE Output (l'autre bout du câble = ce qui part dans Discord)
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cableOut = devs.find(d => d.kind === 'audioinput' && /cable output/i.test(d.label));
      if (!cableOut) { toast('⚠️ CABLE Output introuvable — le câble virtuel est-il installé ?'); stopViz(); $('swViz').checked = false; return; }
      vizStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: cableOut.deviceId } } });
      node = vizCtx.createMediaStreamSource(vizStream);
    }
    vizAnalyser = vizCtx.createAnalyser();
    vizAnalyser.fftSize = 1024;
    node.connect(vizAnalyser);
    $('vizBadge').textContent = 'en marche'; $('vizBadge').className = 'badge ok';
    drawViz();
  } catch (e) {
    toast('Erreur visualiseur : ' + e.message);
    $('swViz').checked = false; stopViz();
  }
}
function stopViz() {
  if (vizRaf) cancelAnimationFrame(vizRaf), vizRaf = null;
  if (vizStream) { vizStream.getTracks().forEach(t => t.stop()); vizStream = null; }
  if (vizCtx) { vizCtx.close().catch(() => {}); vizCtx = null; }
  vizAnalyser = null;
  const b = $('vizBadge'); if (b) { b.textContent = 'arrêté'; b.className = 'badge ko'; }
  const fill = $('vuFill'); if (fill) fill.style.width = '0%';
  const lbl = $('vuLbl'); if (lbl) lbl.textContent = '—';
  const cv = $('vizCanvas'); if (cv) { const c = cv.getContext('2d'); c && c.clearRect(0, 0, cv.width, cv.height); }
}
function drawViz() {
  if (!vizAnalyser) return;
  const cv = $('vizCanvas');
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w) cv.width = w; if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext('2d');
  const buf = new Uint8Array(vizAnalyser.fftSize);
  vizAnalyser.getByteTimeDomainData(buf);
  // waveform
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#5865f2'; ctx.lineWidth = 1.5; ctx.beginPath();
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    if (Math.abs(v) > peak) peak = Math.abs(v);
    const x = (i / buf.length) * w, y = h / 2 + v * h * 0.45;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  // VU
  const pct = Math.min(100, Math.round(peak * 140));
  $('vuFill').style.width = pct + '%';
  $('vuLbl').textContent = peak < 0.01 ? 'silence' : Math.round(20 * Math.log10(peak)) + ' dB';
  vizRaf = requestAnimationFrame(drawViz);
}
$('swViz').addEventListener('change', (e) => e.target.checked ? startViz() : stopViz());
$('vizSource').addEventListener('change', () => { if ($('swViz').checked) startViz(); });

/* ================== Instant replay (onglet dédié) ================== */
let replayCtx = null, replayStream = null, replayProc = null, replaySrcNode = null, replayAnalyser = null;
let replayRing = null, replayWrite = 0, replayFilled = 0, replaySR = 48000, replayActive = false, replayRaf = null;
let replayEma = 0, replayHotStreak = 0;   // détection de moments forts (niveau ambiant + pic soutenu)
let replayEvents = [];                    // [{ t: Date.now(), level, saved }] moments détectés
let replayMomentsTimer = null;            // rafraîchit les « il y a Xs » à l'écran

// Un pic d'énergie soutenu vient d'être détecté dans la capture
function onReplayMoment(rms) {
  const now = Date.now();
  if (replayEvents.length && now - replayEvents[replayEvents.length - 1].t < 6000) return;  // anti-spam
  const ev = { t: now, level: Math.min(1, rms * 4), saved: false };
  replayEvents.push(ev);
  if (replayEvents.length > 8) replayEvents.shift();
  renderReplayMoments();
  if (state.replay.autoClip) {
    // laisse ~2,5 s de suite au moment avant de découper autour du pic
    setTimeout(() => saveMoment(ev, true), 2500);
  }
}

// Extrait une plage du ring buffer : de « startBackSec » en arrière, durée « durSec »
function ringExtract(startBackSec, durSec) {
  if (!replayRing) return null;
  const cap = replayRing.length;
  const maxBack = Math.min(replayFilled, cap) / replaySR;
  const startBack = Math.min(startBackSec, maxBack);
  const n = Math.min(Math.floor(durSec * replaySR), Math.floor(startBack * replaySR));
  if (n <= 0) return null;
  const out = new Float32Array(n);
  const startIdx = (replayWrite - Math.floor(startBack * replaySR) % cap + cap) % cap;
  for (let i = 0; i < n; i++) out[i] = replayRing[(startIdx + i) % cap];
  return out;
}

// Clippe un moment fort : ~4 s avant le pic → ~2,5 s après
async function saveMoment(ev, auto = false) {
  if (ev.saved || !replayActive || !replayRing) return;
  const ageSec = (Date.now() - ev.t) / 1000;
  if (ageSec > 26) { renderReplayMoments(); return; }   // sorti du ring, trop tard
  const PRE = 4, POST = 2.5;
  const startBack = ageSec + PRE;
  const dur = PRE + Math.min(POST, ageSec);   // ne dépasse jamais « maintenant »
  const out = ringExtract(startBack, dur);
  if (!out) return;
  let peak = 0; for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak < 0.005) return;
  const t = new Date(ev.t);
  const pad = (x) => String(x).padStart(2, '0');
  const name = `Moment fort ${pad(t.getHours())}h${pad(t.getMinutes())}m${pad(t.getSeconds())}`;
  const r = await window.sb.saveClip(new Uint8Array(encodeWav(out, replaySR)), name);
  if (r.ok) {
    ev.saved = true;
    clipSelected = r.file;
    toast((auto ? '🔥 Moment fort clippé automatiquement !' : '🔥 Moment clippé !'));
    await loadSounds();
    renderReplayMoments();
  } else if (!auto) toast('❌ ' + (r.error || 'Échec'));
}

/* ================== BÊTA : reconnaissance de sons (YAMNet / ONNX) ================== */
// Catégories proposées -> indices de classes AudioSet regroupés
const YAM_CATS = [
  { id: 'laugh',   emoji: '😂', label: 'Rire',           idx: [13, 14, 15, 16, 17, 18] },
  { id: 'applause',emoji: '👏', label: 'Applaudissements',idx: [58, 61, 62] },
  { id: 'shout',   emoji: '😱', label: 'Cri',            idx: [6, 8, 9, 10, 11] },
  { id: 'music',   emoji: '🎵', label: 'Musique',        idx: [132] },
  { id: 'speech',  emoji: '🗣️', label: 'Parole',         idx: [0, 1, 2, 3] },
  { id: 'crowd',   emoji: '🎉', label: 'Foule / ambiance',idx: [64, 66] },
];
let yamSession = null;       // session ort
let yamEnabled = false;      // reconnaissance active
let yamBusy = false;         // inférence en cours
let yamTimer = null;         // boucle d'inférence
let yamEvents = [];          // [{ t, cat, score, saved }]
const YAM_SR = 16000;        // YAMNet attend du 16 kHz mono

function yamSelectedCats() {
  const sel = state.replay.yamCats || ['laugh', 'applause', 'shout'];
  return YAM_CATS.filter(c => sel.includes(c.id));
}

// Rééchantillonne un Float32Array (replaySR -> 16 kHz) par interpolation linéaire
function resampleTo16k(src, srcSr) {
  const ratio = srcSr / YAM_SR;
  const n = Math.floor(src.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = Math.floor(p), frac = p - i0;
    out[i] = src[i0] * (1 - frac) + (src[i0 + 1] || src[i0]) * frac;
  }
  return out;
}

// Charge le modèle (téléchargé) dans une session ort-web
async function yamLoadModel() {
  if (yamSession) return true;
  if (typeof ort === 'undefined') { toast('❌ Moteur IA (ort) indisponible'); return false; }
  // chemin ABSOLU vers les binaires wasm (un chemin relatif se combine mal -> vendor/vendor)
  ort.env.wasm.wasmPaths = new URL('../vendor/ort/', location.href).href;
  ort.env.wasm.numThreads = 1;   // suffisant, évite les soucis de COOP/COEP
  const r = await window.sb.yamnet.bytes();
  if (!r.ok) { toast('❌ Modèle introuvable'); return false; }
  yamSession = await ort.InferenceSession.create(new Uint8Array(r.data), { executionProviders: ['wasm'] });
  return true;
}

// Analyse la dernière ~1 s de capture et renvoie { cat, score } dominant parmi les catégories cochées
async function yamAnalyse() {
  if (yamBusy || !yamSession || !replayRing) return;
  yamBusy = true;
  try {
    const chunk = ringExtract(1.0, 0.98);   // ~1 s la plus récente
    if (!chunk) return;
    let peak = 0; for (let i = 0; i < chunk.length; i++) peak = Math.max(peak, Math.abs(chunk[i]));
    if (peak < 0.01) { yamShowLive(null); return; }   // silence : rien à classer
    const wav16 = resampleTo16k(chunk, replaySR);
    const input = new ort.Tensor('float32', wav16, [wav16.length]);
    const feeds = {}; feeds[yamSession.inputNames[0]] = input;
    const out = await yamSession.run(feeds);
    const scores = out[yamSession.outputNames[0]].data;   // [frames, 521]
    const nCls = 521, nFr = Math.floor(scores.length / nCls);
    // moyenne des frames -> score par classe
    const avg = new Float32Array(nCls);
    for (let f = 0; f < nFr; f++) for (let c = 0; c < nCls; c++) avg[c] += scores[f * nCls + c];
    for (let c = 0; c < nCls; c++) avg[c] /= (nFr || 1);
    // meilleur score par catégorie cochée (max des indices du groupe)
    let best = null;
    for (const cat of yamSelectedCats()) {
      let s = 0; for (const i of cat.idx) s = Math.max(s, avg[i] || 0);
      if (!best || s > best.score) best = { cat, score: s };
    }
    yamShowLive(best);
    if (best && best.score > 0.35) yamOnDetect(best);
  } catch (e) {
    // en cas d'échec d'inférence, on désactive proprement sans casser la capture
    yamShowLive(null);
  } finally {
    yamBusy = false;
  }
}

function yamShowLive(best) {
  const el = $('yamLive'); if (!el) return;
  if (!best) { el.innerHTML = '<span style="opacity:.6">🎧 En écoute…</span>'; return; }
  el.innerHTML = best.cat.emoji + ' <b>' + esc(best.cat.label) + '</b>' +
    '<span class="bar"><div style="width:' + Math.round(best.score * 100) + '%"></div></span>' +
    ' <span style="opacity:.6">' + Math.round(best.score * 100) + '%</span>';
}

function yamOnDetect(best) {
  const now = Date.now();
  const last = yamEvents[yamEvents.length - 1];
  if (last && last.cat.id === best.cat.id && now - last.t < 5000) return;   // anti-spam par catégorie
  const ev = { t: now, cat: best.cat, score: best.score, saved: false };
  yamEvents.push(ev);
  if (yamEvents.length > 8) yamEvents.shift();
  renderYamEvents();
  if (state.replay.yamAutoClip) setTimeout(() => yamSaveEvent(ev, true), 2000);
}

async function yamSaveEvent(ev, auto = false) {
  if (ev.saved || !replayActive || !replayRing) return;
  const ageSec = (Date.now() - ev.t) / 1000;
  if (ageSec > 26) { renderYamEvents(); return; }
  const PRE = 3.5, POST = 2;
  const out = ringExtract(ageSec + PRE, PRE + Math.min(POST, ageSec));
  if (!out) return;
  const t = new Date(ev.t), pad = (x) => String(x).padStart(2, '0');
  const name = ev.cat.label + ' ' + pad(t.getHours()) + 'h' + pad(t.getMinutes()) + 'm' + pad(t.getSeconds());
  const r = await window.sb.saveClip(new Uint8Array(encodeWav(out, replaySR)), name);
  if (r.ok) {
    ev.saved = true; clipSelected = r.file;
    toast(ev.cat.emoji + (auto ? ' ' + ev.cat.label + ' clippé automatiquement !' : ' ' + ev.cat.label + ' clippé !'));
    await loadSounds(); renderYamEvents();
  } else if (!auto) toast('❌ ' + (r.error || 'Échec'));
}

function renderYamEvents() {
  const box = $('yamEvents'), list = $('yamEventsList');
  if (!box || !list) return;
  yamEvents = yamEvents.filter(ev => (Date.now() - ev.t) / 1000 < 26 || ev.saved);
  const evs = [...yamEvents].reverse();
  if (!yamEnabled || !evs.length) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  list.innerHTML = '';
  for (const ev of evs) {
    const age = Math.round((Date.now() - ev.t) / 1000);
    const el = document.createElement('div');
    el.className = 'rm-item';
    el.innerHTML =
      '<span class="rm-age">' + ev.cat.emoji + ' il y a ' + age + ' s</span>' +
      '<span class="rm-bar"><div style="width:' + Math.round(ev.score * 100) + '%"></div></span>' +
      (ev.saved ? '<span class="rm-saved">✓ clippé</span>' : '<button class="testbtn">💾 Clipper</button>');
    if (!ev.saved) el.querySelector('button').addEventListener('click', () => yamSaveEvent(ev));
    list.appendChild(el);
  }
}

// Active/désactive la reconnaissance (démarre la capture au besoin)
async function yamToggle(on) {
  yamEnabled = on;
  if (on) {
    if (!replayActive) { $('swReplay2').checked = true; await startReplay(); }
    if (!replayActive) { yamEnabled = false; $('yamSwitch').checked = false; return; }
    const ok = await yamLoadModel();
    if (!ok) { yamEnabled = false; $('yamSwitch').checked = false; return; }
    yamEvents = [];
    if (yamTimer) clearInterval(yamTimer);
    yamTimer = setInterval(yamAnalyse, 1000);
    yamShowLive(null);
    toast('🧪 Reconnaissance de sons activée');
  } else {
    if (yamTimer) { clearInterval(yamTimer); yamTimer = null; }
    $('yamLive').innerHTML = '';
    renderYamEvents();
  }
  refreshYamUI();
}

// Rafraîchit l'UI de la section bêta selon l'état (installé ? actif ?)
async function refreshYamUI() {
  if (!$('yamSwitch')) return;   // DOM bêta pas encore prêt
  let ready = false;
  try { ready = (await window.sb.yamnet.status()).ready; } catch {}
  $('yamInstall').style.display = ready ? 'none' : (yamWantsOn ? 'block' : 'none');
  $('yamCats').style.display = (ready && yamEnabled) ? 'block' : 'none';
  $('yamSwitch').checked = yamEnabled;
  if (ready && yamEnabled) { renderYamChips(); renderYamEvents(); }
}

function renderYamChips() {
  const box = $('yamChips'); if (!box) return;
  const sel = state.replay.yamCats || ['laugh', 'applause', 'shout'];
  box.innerHTML = '';
  for (const c of YAM_CATS) {
    const chip = document.createElement('span');
    chip.className = 'yam-chip' + (sel.includes(c.id) ? ' on' : '');
    chip.textContent = c.emoji + ' ' + c.label;
    chip.addEventListener('click', () => {
      const s = new Set(state.replay.yamCats || ['laugh', 'applause', 'shout']);
      s.has(c.id) ? s.delete(c.id) : s.add(c.id);
      state.replay.yamCats = [...s]; saveState(); renderYamChips();
    });
    box.appendChild(chip);
  }
}

let yamWantsOn = false;   // l'utilisateur a cliqué le switch mais le modèle manque

// Liste des moments forts sous la zone de capture
function renderReplayMoments() {
  const box = $('replayMoments'), list = $('replayMomentsList');
  if (!box || !list) return;
  // ne garde que les moments encore présents dans le ring (~26 s de marge)
  replayEvents = replayEvents.filter(ev => (Date.now() - ev.t) / 1000 < 26 || ev.saved);
  const evs = [...replayEvents].reverse();
  if (!replayActive || !evs.length) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  list.innerHTML = '';
  for (const ev of evs) {
    const age = Math.round((Date.now() - ev.t) / 1000);
    const el = document.createElement('div');
    el.className = 'rm-item';
    el.innerHTML =
      '<span class="rm-age">il y a ' + age + ' s</span>' +
      '<span class="rm-bar"><div style="width:' + Math.round(ev.level * 100) + '%"></div></span>' +
      (ev.saved
        ? '<span class="rm-saved">✓ clippé</span>'
        : '<button class="testbtn">💾 Clipper</button>');
    if (!ev.saved) el.querySelector('button').addEventListener('click', () => saveMoment(ev));
    list.appendChild(el);
  }
}

// Met à jour l'affichage de l'onglet Replay selon l'état de la capture
function refreshReplayTab() {
  const on = replayActive;
  const sw = $('swReplay2'); if (sw) sw.checked = on;
  const st = $('replayState2');
  if (st) { st.textContent = on ? 'Capture active 🔴' : 'Capture inactive'; st.className = 'replay-status' + (on ? ' on' : ''); }
  const grab = $('replayGrab');
  if (grab) {
    grab.disabled = !on;
    grab.classList.toggle('armed', on);
    grab.querySelector('.replay-grab-txt').textContent = on
      ? 'Capturer les ' + fin(state.replay.seconds, 5) + ' dernières secondes'
      : 'Activer la capture d\'abord';
  }
  const btnTop = $('btnReplay'); if (btnTop) btnTop.style.display = on ? '' : 'none';
  const hint = $('replayHint2');
  if (hint) {
    if (on) {
      const src = state.replay.source === 'monitor' ? 'le son de ton PC' : 'ton micro';
      hint.innerHTML = 'Capture de <b>' + src + '</b> active. Le bouton <b>💾 Replay</b> (en haut) et le raccourci <b>Ctrl+Alt+R</b> fonctionnent depuis n\'importe où, même en jeu.';
    } else {
      hint.innerHTML = 'Active la capture, puis laisse tourner. Tu pourras figer les dernières secondes à tout moment.';
    }
  }
  renderClips();
  refreshYamUI();
}

/* ---------- Panneau des enregistrements (colonne droite) ---------- */
const RECORDINGS_FOLDER = 'Enregistrements';
let clipSelected = null;   // fichier sélectionné dans la liste

function recordingClips() {
  return sounds
    .filter(s => s.folder === RECORDINGS_FOLDER)
    .sort((a, b) => b.mtime - a.mtime);   // plus récents en haut
}

function renderClips() {
  const box = $('clipsList');
  if (!box) return;
  const clips = recordingClips();
  $('clipsCount').textContent = clips.length;
  if (!clips.length) {
    box.innerHTML = '<div class="clips-empty">🎬 Aucun enregistrement pour l\'instant.<br>Active la capture et fige un moment&nbsp;!</div>';
    return;
  }
  box.innerHTML = '';
  const playing = new Set(active.values());
  for (const s of clips) {
    const el = document.createElement('div');
    el.className = 'clip-item' + (s.file === clipSelected ? ' sel' : '') + (playing.has(s.file) ? ' playing' : '');
    el.dataset.file = s.file;
    const dur = durations.has(s.file) ? fmtDur(durations.get(s.file)) : '…';
    el.innerHTML =
      '<span class="clip-play">▶</span>' +
      '<div class="clip-info"><div class="clip-name">' + esc(s.name) + '</div>' +
      '<div class="clip-meta">' + dur + '</div></div>' +
      '<div class="clip-actions">' +
        '<button data-clip-act="promote" title="Ajouter aux Sons (choisir une catégorie)">➕</button>' +
        '<button data-clip-act="edit" title="Éditer / découper">✂️</button>' +
        '<button data-clip-act="rename" title="Renommer">✏️</button>' +
        '<button data-clip-act="del" title="Supprimer">🗑️</button>' +
      '</div>';
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-clip-act]')?.dataset.clipAct;
      clipSelected = s.file;
      if (act === 'promote') { clipToSounds(s, e); return; }
      if (act === 'edit') { openAudioEditor(s); return; }
      if (act === 'rename') { clipRename(s); return; }
      if (act === 'del') { clipDelete(s); return; }
      playSound(s, { localOnly: true });   // clic simple = écoute privée
      renderClips();
    });
    if (!durations.has(s.file)) loadDuration(s, el);
    box.appendChild(el);
  }
}

// « Ajouter aux Sons » : sort le clip de « Enregistrements » vers une catégorie
// choisie (menu), en la créant au besoin.
function clipToSounds(s, e) {
  const ctx = $('ctx');
  const cats = folders.filter(f => f !== RECORDINGS_FOLDER);
  const x = e ? e.clientX : innerWidth / 2, y = e ? e.clientY : 120;
  // différé d'un tick : laisse le clic courant se terminer (sinon le handler
  // global de fermeture du menu le referme aussitôt).
  setTimeout(() => {
    ctx.innerHTML =
      '<div style="padding:6px 12px;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em">Ajouter dans…</div>' +
      '<div data-cat="">📁 Général (racine)</div>' +
      cats.map(f => '<div data-cat="' + esc(f) + '">📁 ' + esc(f) + '</div>').join('') +
      '<div data-cat="__new__" style="border-top:1px solid var(--border);margin-top:4px">➕ Nouvelle catégorie…</div>';
    ctx.style.display = 'block';
    const r = ctx.getBoundingClientRect();
    ctx.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
    ctx.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
    ctx.addEventListener('click', onPick);
  }, 0);

  const onPick = async (ev) => {
    const item = ev.target.closest('[data-cat]');
    if (!item) return;
    ev.stopPropagation();
    ctx.style.display = 'none';
    ctx.removeEventListener('click', onPick);
    let folder = item.dataset.cat;
    if (folder === '__new__') {
      const name = await askText({ title: '📁 Nouvelle catégorie', sub: 'Nom du dossier de sons' });
      if (!name) return;
      const cr = await window.sb.createFolder(name);
      if (!cr.ok) { toast('❌ ' + (cr.error || 'Erreur')); return; }
      folder = cr.folder;
    }
    const mv = await window.sb.moveSound(s.file, folder);
    if (mv.ok) {
      remapFile(s.file, mv.file);
      if (clipSelected === s.file) clipSelected = null;
      toast('✅ Ajouté aux Sons dans « ' + (folder || 'Général') + ' »');
      await loadSounds();
    } else toast('❌ ' + (mv.error || 'Erreur'));
  };
}

async function clipRename(s) {
  const n = await askText({ title: '✏️ Renommer l\'enregistrement', sub: s.name, value: s.name });
  if (!n || n.trim() === s.name) return;
  const r = await window.sb.rename(s.file, n.trim());
  if (r.ok) { remapFile(s.file, r.file); clipSelected = r.file; await loadSounds(); }
  else toast('❌ ' + (r.error || 'Erreur'));
}
async function clipDelete(s) {
  if (!confirm('Supprimer « ' + s.name + ' » ?\n(Déplacé dans _corbeille)')) return;
  const r = await window.sb.remove(s.file);
  if (r.ok) {
    const ic = state.icons[s.file];
    if (ic) { if (ic.image) window.sb.removeIcon(ic.image); delete state.icons[s.file]; saveState(); }
    if (clipSelected === s.file) clipSelected = null;
    toast('🗑️ Enregistrement supprimé'); await loadSounds();
  } else toast('❌ ' + (r.error || 'Erreur'));
}
$('clipsRefresh').addEventListener('click', () => loadSounds());

async function startReplay() {
  stopReplay();
  const source = state.replay.source;
  try {
    if (source === 'mic') {
      const devId = state.mic.deviceId && state.mic.deviceId !== 'default' ? { exact: state.mic.deviceId } : undefined;
      replayStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: devId, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } else {
      // « ce que j'entends » : capture le son SYSTÈME (WASAPI loopback), sans Mixage stéréo.
      // getDisplayMedia passe par le handler loopback du main process ; on jette la vidéo.
      let disp;
      try {
        disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      } catch (err) {
        $('replayHint2').innerHTML = '⚠️ Capture du son système refusée. Réessaie, ou utilise la source « Mon micro ».';
        $('swReplay2').checked = false; return;
      }
      disp.getVideoTracks().forEach(t => t.stop());          // on n'a pas besoin de l'image
      const audioTracks = disp.getAudioTracks();
      if (!audioTracks.length) {
        $('replayHint2').innerHTML = '⚠️ Aucun son système capté. Vérifie qu\'un son joue, puis réessaie.';
        $('swReplay2').checked = false; return;
      }
      replayStream = new MediaStream(audioTracks);
    }
    // si la capture s'interrompt (fin de piste), on coupe proprement
    replayStream.getTracks().forEach(t => { t.onended = () => { if (replayActive) { $('swReplay2').checked = false; stopReplay(); toast('⏹ Capture interrompue'); } }; });
    replayCtx = new AudioContext();
    replaySR = replayCtx.sampleRate;
    replaySrcNode = replayCtx.createMediaStreamSource(replayStream);
    // analyseur pour la forme d'onde live de l'onglet
    replayAnalyser = replayCtx.createAnalyser();
    replayAnalyser.fftSize = 1024;
    replaySrcNode.connect(replayAnalyser);
    // ring buffer des N dernières secondes (max 32 pour couvrir jusqu'à 30 s)
    const capacity = replaySR * 32;
    replayRing = new Float32Array(capacity);
    replayWrite = 0; replayFilled = 0;
    replayProc = replayCtx.createScriptProcessor(4096, 1, 1);
    replayEma = 0; replayHotStreak = 0;
    replayProc.onaudioprocess = (e) => {
      const inp = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < inp.length; i++) {
        replayRing[replayWrite] = inp[i];
        replayWrite = (replayWrite + 1) % capacity;
        sum += inp[i] * inp[i];
      }
      replayFilled = Math.min(capacity, replayFilled + inp.length);
      // ----- détection de moments forts : pic d'énergie soutenu vs niveau ambiant -----
      const rms = Math.sqrt(sum / inp.length);
      const hot = rms > Math.max(0.045, replayEma * 3.5);
      if (!hot) replayEma = replayEma * 0.985 + rms * 0.015;   // le niveau ambiant ignore les pics
      replayHotStreak = hot ? replayHotStreak + 1 : 0;
      if (replayHotStreak === 3) onReplayMoment(rms);           // ~250 ms de pic continu = moment fort
    };
    replaySrcNode.connect(replayProc);
    replayProc.connect(replayCtx.destination);
    replayActive = true;
    replayEvents = [];
    if (replayMomentsTimer) clearInterval(replayMomentsTimer);
    replayMomentsTimer = setInterval(renderReplayMoments, 1000);   // met à jour les « il y a Xs »
    refreshReplayTab();
    drawReplayWave();
  } catch (e) {
    toast('Erreur replay : ' + e.message);
    $('swReplay2').checked = false; stopReplay();
  }
}
function stopReplay() {
  if (replayRaf) { cancelAnimationFrame(replayRaf); replayRaf = null; }
  if (replayProc) { try { replayProc.disconnect(); } catch {} replayProc.onaudioprocess = null; replayProc = null; }
  if (replayAnalyser) { try { replayAnalyser.disconnect(); } catch {} replayAnalyser = null; }
  if (replaySrcNode) { try { replaySrcNode.disconnect(); } catch {} replaySrcNode = null; }
  if (replayStream) { replayStream.getTracks().forEach(t => t.stop()); replayStream = null; }
  if (replayCtx) { replayCtx.close().catch(() => {}); replayCtx = null; }
  replayRing = null; replayActive = false;
  replayEvents = [];
  if (replayMomentsTimer) { clearInterval(replayMomentsTimer); replayMomentsTimer = null; }
  renderReplayMoments();
  // coupe aussi la reconnaissance de sons (elle a besoin de la capture)
  if (yamEnabled) { yamEnabled = false; if (yamTimer) { clearInterval(yamTimer); yamTimer = null; } yamEvents = []; refreshYamUI(); }
  refreshReplayTab();
  const cv = $('replayWave'); if (cv) { const c = cv.getContext('2d'); c && c.clearRect(0, 0, cv.width, cv.height); }
  const vu = $('replayVu'); if (vu) vu.style.width = '0%';
}
// Forme d'onde + VU en direct sur l'onglet Replay
function drawReplayWave() {
  if (!replayAnalyser) return;
  const cv = $('replayWave');
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w) cv.width = w; if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext('2d');
  const buf = new Uint8Array(replayAnalyser.fftSize);
  replayAnalyser.getByteTimeDomainData(buf);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = replayActive ? '#da373c' : '#5865f2';
  ctx.lineWidth = 1.6; ctx.beginPath();
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    if (Math.abs(v) > peak) peak = Math.abs(v);
    const x = (i / buf.length) * w, y = h / 2 + v * h * 0.45;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  const vu = $('replayVu'); if (vu) vu.style.width = Math.min(100, Math.round(peak * 140)) + '%';
  replayRaf = requestAnimationFrame(drawReplayWave);
}
// Encode un Float32Array mono en WAV (PCM 16 bits)
function encodeWav(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); wr(8, 'WAVE');
  wr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  wr(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return buf;
}
async function saveReplay() {
  if (!replayActive || !replayRing) { toast('⚠️ Active d\'abord la capture (onglet ⏺ Replay)'); return; }
  const secs = fin(state.replay.seconds, 5);
  const cap = replayRing.length;
  const n = Math.min(replayFilled, Math.floor(secs * replaySR));
  const out = new Float32Array(n);
  // lit les n derniers échantillons dans l'ordre chronologique
  let start = (replayWrite - n + cap) % cap;
  for (let i = 0; i < n; i++) out[i] = replayRing[(start + i) % cap];
  // vérifie qu'il y a du signal
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak < 0.005) { toast('⚠️ Rien à capturer (silence)'); return; }
  const wav = encodeWav(out, replaySR);
  const r = await window.sb.saveClip(new Uint8Array(wav), 'Replay');
  if (r.ok) {
    clipSelected = r.file;            // sélectionne le clip fraîchement enregistré
    const label = r.file.includes('/') ? r.file.slice(r.file.lastIndexOf('/') + 1) : r.file;
    toast('⏺ Enregistré : ' + label.replace(/\.wav$/i, ''));
    await loadSounds();
    if ($('replayView').style.display === 'block') switchTab('replay');  // rafraîchit la liste
  } else toast('❌ ' + (r.error || 'Échec'));
}
// Bindings de l'onglet Replay
$('swReplay2').addEventListener('change', (e) => e.target.checked ? startReplay() : stopReplay());
$('replayGrab').addEventListener('click', saveReplay);
$('replaySource2').addEventListener('change', (e) => { state.replay.source = e.target.value; saveState(); if (replayActive) startReplay(); });
(() => {
  const el = $('replayDur2'), lbl = $('replayDurLbl2');
  el.value = fin(state.replay.seconds, 5); lbl.textContent = el.value + ' s';
  el.addEventListener('input', () => {
    lbl.textContent = el.value + ' s'; state.replay.seconds = +el.value; saveState(); refreshReplayTab();
  });
  $('replaySource2').value = state.replay.source || 'mic';
  // capture auto au lancement + auto-clip des moments forts
  $('replayAuto').checked = !!state.replay.auto;
  $('replayAutoClip').checked = !!state.replay.autoClip;
  $('replayAuto').addEventListener('change', (e) => { state.replay.auto = e.target.checked; saveState(); });
  $('replayAutoClip').addEventListener('change', (e) => { state.replay.autoClip = e.target.checked; saveState(); });

  // ----- Section BÊTA : reconnaissance de sons (YAMNet) -----
  $('yamAutoClip').checked = !!state.replay.yamAutoClip;
  $('yamAutoClip').addEventListener('change', (e) => { state.replay.yamAutoClip = e.target.checked; saveState(); });
  $('yamSwitch').addEventListener('change', async (e) => {
    if (e.target.checked) {
      yamWantsOn = true;
      const st = await window.sb.yamnet.status();
      if (!st.ready) {   // modèle absent : montre le bouton d'installation, n'active pas encore
        $('yamSwitch').checked = false;
        await refreshYamUI();
        $('yamInstall').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      await yamToggle(true);
    } else {
      await yamToggle(false);
    }
  });
  $('yamInstallBtn').addEventListener('click', async () => {
    const btn = $('yamInstallBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spin">⏳</span> Téléchargement du modèle…';
    $('yamInstallLog').textContent = 'Récupération de YAMNet (~15 Mo)…';
    const r = await window.sb.yamnet.ensure();
    btn.disabled = false; btn.innerHTML = '📥 Activer la reconnaissance (~15 Mo, une fois)';
    if (r.ok) {
      $('yamInstallLog').textContent = '';
      $('yamSwitch').checked = true;
      await yamToggle(true);
    } else {
      $('yamInstallLog').textContent = '❌ ' + (r.error || 'Échec du téléchargement');
    }
  });
})();
$('btnReplay').addEventListener('click', saveReplay);

/* ================== Replay VIDÉO (ShadowPlay) ================== */
// Buffer continu vidéo+audio : MediaRecorder en mode timeslice découpe
// l'encodage en petits morceaux WebM ; on garde en mémoire une file glissante
// des N dernières secondes. À la capture, on concatène -> un .webm.
let vidStream = null;        // flux écran (vidéo) + audio mixé
let vidRecorder = null;      // MediaRecorder
let vidChunks = [];          // [{ blob, t }] file glissante des morceaux
let vidActive = false;
let vidAudioCtx = null;      // pour mixer PC + micro si besoin
const VID_TIMESLICE = 1000;  // 1 morceau / seconde (granularité de coupe)

function vidSelectedSeconds() { return fin(state.replay.video.seconds, 30); }

// Construit la contrainte vidéo selon la qualité choisie
function vidVideoConstraints() {
  const q = state.replay.video.quality;
  if (q === 'native') return { frameRate: 30 };
  const h = q === '720' ? 720 : 1080;
  return { frameRate: 30, height: { ideal: h } };
}

async function startVideoReplay() {
  stopVideoReplay();
  try {
    // getDisplayMedia -> handler main (écran entier + audio loopback dispo)
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: vidVideoConstraints(),
      audio: true,   // le handler renvoie l'audio loopback (son du PC)
    });
    const videoTrack = display.getVideoTracks()[0];
    if (!videoTrack) throw new Error('Aucune source vidéo');
    videoTrack.onended = () => { if (vidActive) { $('swVideo').checked = false; stopVideoReplay(); toast('⏹ Capture vidéo arrêtée'); } };

    // ----- construction de la piste audio selon le réglage -----
    const audioMode = state.replay.video.audio;
    const sysTracks = display.getAudioTracks();
    let finalAudioTracks = [];
    if (audioMode === 'none') {
      finalAudioTracks = [];
      sysTracks.forEach(t => t.stop());
    } else if (audioMode === 'system') {
      finalAudioTracks = sysTracks;
    } else {
      // micro requis (mic seul ou both)
      let micStream = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: state.mic.deviceId && state.mic.deviceId !== 'default' ? { exact: state.mic.deviceId } : undefined,
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          },
        });
      } catch (e) { micStream = null; }
      if (audioMode === 'mic') {
        sysTracks.forEach(t => t.stop());
        finalAudioTracks = micStream ? micStream.getAudioTracks() : [];
      } else {
        // both : mixe PC + micro dans un seul flux via Web Audio
        vidAudioCtx = new AudioContext();
        const dest = vidAudioCtx.createMediaStreamDestination();
        if (sysTracks.length) vidAudioCtx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest);
        if (micStream) vidAudioCtx.createMediaStreamSource(micStream).connect(dest);
        finalAudioTracks = dest.stream.getAudioTracks();
        vidStreamExtra = [display, micStream];   // à arrêter au stop
      }
    }

    vidStream = new MediaStream([videoTrack, ...finalAudioTracks]);
    vidStreamRaw = display;   // pour arrêter toutes les pistes au stop

    // aperçu
    const pv = $('vidPreview');
    pv.srcObject = new MediaStream([videoTrack]);
    pv.play().catch(() => {});
    $('vidPreviewWrap').classList.add('on');

    // MediaRecorder : choisit le meilleur codec dispo
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    vidRecorder = new MediaRecorder(vidStream, { mimeType: mime, videoBitsPerSecond: state.replay.video.quality === '720' ? 4_000_000 : 8_000_000 });
    vidChunks = [];
    vidRecorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      vidChunks.push({ blob: e.data, t: Date.now() });
      // purge : ne garde que les morceaux plus récents que la durée voulue (+2 s de marge)
      const cutoff = Date.now() - (vidSelectedSeconds() + 2) * 1000;
      while (vidChunks.length > 2 && vidChunks[0].t < cutoff) vidChunks.shift();
    };
    vidRecorder.start(VID_TIMESLICE);
    vidActive = true;
    refreshVideoTab();
  } catch (e) {
    toast('Erreur capture vidéo : ' + (e.message || e));
    $('swVideo').checked = false;
    stopVideoReplay();
  }
}
let vidStreamRaw = null, vidStreamExtra = null;

function stopVideoReplay() {
  if (vidRecorder && vidRecorder.state !== 'inactive') { try { vidRecorder.stop(); } catch {} }
  vidRecorder = null;
  for (const s of [vidStreamRaw, vidStream, ...(vidStreamExtra || [])]) {
    if (s && s.getTracks) s.getTracks().forEach(t => t.stop());
  }
  vidStreamRaw = vidStream = vidStreamExtra = null;
  if (vidAudioCtx) { vidAudioCtx.close().catch(() => {}); vidAudioCtx = null; }
  vidChunks = [];
  vidActive = false;
  const pv = $('vidPreview'); if (pv) { pv.srcObject = null; }
  const wrap = $('vidPreviewWrap'); if (wrap) wrap.classList.remove('on');
  refreshVideoTab();
}

// Fige les dernières secondes en un fichier .webm
async function saveVideoClip() {
  if (!vidActive || !vidRecorder) { toast('⚠️ Active d\'abord la capture vidéo'); return; }
  if (!vidChunks.length) { toast('⏳ Le buffer se remplit, réessaie dans 1 s'); return; }
  toast('🎬 Enregistrement du clip…');
  // force l'écriture du morceau en cours pour ne pas perdre la dernière seconde
  try { vidRecorder.requestData(); } catch {}
  await new Promise(r => setTimeout(r, 250));
  const wanted = vidSelectedSeconds() * 1000;
  const now = Date.now();
  const keep = vidChunks.filter(c => c.t >= now - wanted);
  const blobs = (keep.length ? keep : vidChunks).map(c => c.blob);
  const blob = new Blob(blobs, { type: vidRecorder.mimeType || 'video/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const r = await window.sb.saveVideoClip(buf, null);
  if (r.ok) {
    toast('🎬 Clip vidéo enregistré (' + Math.round(blob.size / 1e6 * 10) / 10 + ' Mo)');
    await loadVideoClips();
  } else toast('❌ ' + (r.error || 'Échec'));
}

function refreshVideoTab() {
  const on = vidActive;
  const sw = $('swVideo'); if (sw) sw.checked = on;
  const st = $('vidState');
  if (st) { st.textContent = on ? 'Capture active 🔴' : 'Capture inactive'; st.className = 'replay-status' + (on ? ' on' : ''); }
  const grab = $('vidGrab');
  if (grab) {
    grab.disabled = !on;
    grab.querySelector('.replay-grab-txt').textContent = on
      ? 'Capturer les ' + vidSelectedSeconds() + ' dernières secondes'
      : 'Active la capture d\'abord';
  }
}

async function loadVideoClips() {
  const box = $('vidList'); if (!box) return;
  const clips = await window.sb.listVideoClips();
  $('vidCount').textContent = clips.length;
  if (!clips.length) {
    box.innerHTML = '<div class="clips-empty">🎬 Aucun clip vidéo.<br>Active la capture et fige un moment&nbsp;!</div>';
    return;
  }
  box.innerHTML = '';
  for (const c of clips) {
    const el = document.createElement('div');
    el.className = 'vid-clip';
    const mb = Math.round(c.size / 1e6 * 10) / 10;
    const when = new Date(c.mtime);
    el.innerHTML =
      '<div class="vc-thumb">🎬</div>' +
      '<div class="vc-info"><div class="vc-name">' + esc(c.file.replace(/\.webm$/i, '')) + '</div>' +
      '<div class="vc-meta">' + mb + ' Mo · ' + when.toLocaleTimeString() + '</div></div>' +
      '<div class="vc-acts">' +
        '<button data-vc="folder" title="Voir dans le dossier">📂</button>' +
        '<button data-vc="del" title="Supprimer">🗑️</button>' +
      '</div>';
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-vc]')?.dataset.vc;
      if (act === 'folder') { window.sb.openVideoClip(c.file); return; }
      if (act === 'del') { vidClipDelete(c.file); return; }
      openVideoPlayer(c.file);
    });
    box.appendChild(el);
  }
}

async function vidClipDelete(file) {
  if (!confirm('Supprimer ce clip vidéo ?')) return;
  const r = await window.sb.deleteVideoClip(file);
  if (r.ok) { toast('🗑️ Clip supprimé'); await loadVideoClips(); }
  else toast('❌ ' + (r.error || 'Erreur'));
}

function openVideoPlayer(file) {
  $('vidPlayerName').textContent = file.replace(/\.webm$/i, '');
  const v = $('vidPlayerEl');
  v.src = window.sb.videoUrl(file);
  $('vidPlayer').style.display = 'flex';
  // Les WebM de MediaRecorder n'ont pas de durée dans leur header (duration=Infinity),
  // ce qui casse la barre de progression/seek. Astuce : on force un seek en fin de
  // média, le navigateur recalcule alors la vraie durée, puis on revient au début.
  fixWebmDuration(v);
  v.play().catch(() => {});
}
function fixWebmDuration(v) {
  const onMeta = () => {
    if (v.duration === Infinity || isNaN(v.duration)) {
      const restore = () => {
        v.removeEventListener('timeupdate', restore);
        v.currentTime = 0;   // revient au début une fois la durée connue
      };
      v.addEventListener('timeupdate', restore);
      v.currentTime = 1e9;   // provoque le recalcul de la durée
    }
  };
  v.addEventListener('loadedmetadata', onMeta, { once: true });
}
function closeVideoPlayer() {
  const v = $('vidPlayerEl');
  v.pause(); v.removeAttribute('src'); v.load();
  $('vidPlayer').style.display = 'none';
}

// ----- Bascule mode audio/vidéo dans l'onglet Replay -----
function setReplayMode(mode) {
  state.replay.mode = mode; saveState();
  document.querySelectorAll('.rmode').forEach(b => b.classList.toggle('active', b.dataset.rmode === mode));
  $('replayModeAudio').style.display = mode === 'audio' ? '' : 'none';
  $('replayModeVideo').style.display = mode === 'video' ? '' : 'none';
  if (mode === 'video') loadVideoClips();
}

// ----- Bindings vidéo -----
document.querySelectorAll('.rmode').forEach(b => b.addEventListener('click', () => setReplayMode(b.dataset.rmode)));
$('swVideo').addEventListener('change', (e) => e.target.checked ? startVideoReplay() : stopVideoReplay());
$('vidGrab').addEventListener('click', saveVideoClip);
$('vidRefresh').addEventListener('click', loadVideoClips);
$('vidReveal').addEventListener('click', () => window.sb.revealVideoClips());
$('vidPlayerClose').addEventListener('click', closeVideoPlayer);
$('vidPlayer').addEventListener('click', (e) => { if (e.target === $('vidPlayer')) closeVideoPlayer(); });
(() => {
  const sel = $('vidAudio'); sel.value = state.replay.video.audio;
  sel.addEventListener('change', () => { state.replay.video.audio = sel.value; saveState(); if (vidActive) startVideoReplay(); });
  const q = $('vidQuality'); q.value = state.replay.video.quality;
  q.addEventListener('change', () => { state.replay.video.quality = q.value; saveState(); if (vidActive) startVideoReplay(); });
  const dur = $('vidDur'), lbl = $('vidDurLbl');
  dur.value = vidSelectedSeconds();
  lbl.textContent = dur.value >= 60 ? (dur.value % 60 === 0 ? (dur.value / 60) + ' min' : Math.floor(dur.value / 60) + ' min ' + (dur.value % 60) + ' s') : dur.value + ' s';
  dur.addEventListener('input', () => {
    const v = +dur.value;
    lbl.textContent = v >= 60 ? (v % 60 === 0 ? (v / 60) + ' min' : Math.floor(v / 60) + ' min ' + (v % 60) + ' s') : v + ' s';
    state.replay.video.seconds = v; saveState(); refreshVideoTab();
  });
  const auto = $('vidAuto'); auto.checked = !!state.replay.video.auto;
  auto.addEventListener('change', () => { state.replay.video.auto = auto.checked; saveState(); });
})();

/* ================== Événements Electron ================== */
window.sb.onSoundsChanged(() => loadSounds());
window.sb.onHotkey((acc) => { const f = state.hotkeys[acc]; if (f) playSound(sounds.find(x => x.file === f)); });
window.sb.onStopAll(() => stopAll());
// Ctrl+Alt+R : fige le clip. Si une capture vidéo tourne, on privilégie la vidéo
// (l'audio reste dispo aussi si son ring tourne).
window.sb.onReplaySave(() => { if (vidActive) saveVideoClip(); else saveReplay(); });
// lecture demandée depuis l'overlay in-game
window.sb.onOverlayPlay((file) => { const s = sounds.find(x => x.file === file); if (s) playSound(s); });
$('btnOverlay').addEventListener('click', () => window.sb.overlay.toggle());

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
  refreshIaSection();   // prépare la section Voix IA dès le démarrage (sans attendre l'onglet)
  renderOnboard();      // checklist premier lancement (se cache une fois complétée)
  if (state.replay.auto) startReplay();   // ShadowPlay audio : le ring tourne dès l'ouverture
  if (state.replay.video && state.replay.video.auto) startVideoReplay();   // ShadowPlay vidéo

  // Au démarrage : si le câble audio est absent, propose l'assistant d'installation.
  // (Windows uniquement ; on ne redemande pas si l'utilisateur a choisi « Plus tard ».)
  try {
    const cs = await window.sb.cable.status();
    if (!cs.installed && !localStorage.getItem('sb-setup-dismissed')) {
      openSetup();
    }
  } catch {}

  if (!localStorage.getItem('sb-visited')) {
    localStorage.setItem('sb-visited', '1');
    if (localStorage.getItem('sb-setup-dismissed') || $('setupModal').classList.contains('show') === false) {
      $('settings').classList.add('open');
    }
  }
})();
