'use strict';
/*
 * Moteur de modulation de voix en temps réel (Web Audio).
 * Construit une chaîne d'effets insérée entre le micro et la sortie (câble virtuel).
 *
 *   micGain ──> [ SoundTouch pitch ] ──> [ effets ] ──> outNode
 *
 * Chaque preset décrit : un décalage de pitch (demi-tons) + une liste d'effets.
 * L'objet VoiceFX gère la (re)construction de la chaîne quand on change de preset.
 */

/* ========== Définition des presets ========== */
// type d'effets : 'robot', 'reverb', 'echo', 'radio', 'distortion', 'tremolo'
// color = teinte de la carte (halo + sélection) · desc = sous-titre parlant ·
// svg  = icône dessinée sur mesure (contenu d'un viewBox 0 0 48 48)
const VOICE_PRESETS = [
  { id: 'none', name: 'Normale', emoji: '🎤', pitch: 0, effects: [],
    color: '#5865f2', desc: 'Ta vraie voix',
    svg: '<rect x="18" y="6" width="12" height="20" rx="6" fill="#5865f2"/>' +
         '<line x1="21" y1="12" x2="27" y2="12" stroke="#c7d0ff" stroke-width="2" stroke-linecap="round"/>' +
         '<line x1="21" y1="17" x2="27" y2="17" stroke="#c7d0ff" stroke-width="2" stroke-linecap="round"/>' +
         '<path d="M12 22a12 12 0 0 0 24 0" fill="none" stroke="#8ea1e1" stroke-width="3" stroke-linecap="round"/>' +
         '<line x1="24" y1="34" x2="24" y2="39" stroke="#8ea1e1" stroke-width="3" stroke-linecap="round"/>' +
         '<rect x="16" y="39" width="16" height="3.5" rx="1.75" fill="#8ea1e1"/>' },
  { id: 'deep', name: 'Grave / Monstre', emoji: '👹', pitch: -6, effects: [],
    color: '#e2593b', desc: 'Très grave',
    svg: '<path d="M12 7l8 7-10 3z" fill="#b23c17"/><path d="M36 7l-8 7 10 3z" fill="#b23c17"/>' +
         '<rect x="10" y="13" width="28" height="26" rx="9" fill="#e2593b"/>' +
         '<circle cx="18.5" cy="24" r="3.6" fill="#fff"/><circle cx="29.5" cy="24" r="3.6" fill="#fff"/>' +
         '<circle cx="18.5" cy="24.8" r="1.6" fill="#1a1c20"/><circle cx="29.5" cy="24.8" r="1.6" fill="#1a1c20"/>' +
         '<path d="M14 18.5l7 2.5M34 18.5l-7 2.5" stroke="#7f2b12" stroke-width="3" stroke-linecap="round"/>' +
         '<path d="M16 31.5h16v2.5a2.5 2.5 0 0 1-2.5 2.5h-11a2.5 2.5 0 0 1-2.5-2.5z" fill="#5e1f0c"/>' +
         '<path d="M18.5 31.5l1.9 4 1.9-4zM25.7 31.5l1.9 4 1.9-4z" fill="#fff"/>' },
  { id: 'demon', name: 'Démon', emoji: '😈', pitch: -9, effects: [{ t: 'reverb', mix: 0.35, seconds: 2.2 }, { t: 'distortion', amount: 12 }],
    color: '#ef4444', desc: 'Grave + distorsion',
    svg: '<path d="M13 5c-1.5 5 .5 9 5 11l4-5c-4-1.5-7-3-9-6z" fill="#991b1b"/>' +
         '<path d="M35 5c1.5 5-.5 9-5 11l-4-5c4-1.5 7-3 9-6z" fill="#991b1b"/>' +
         '<path d="M24 11c8.5 0 14.5 5.3 14.5 13.5C38.5 33.7 31.5 39 24 39S9.5 33.7 9.5 24.5C9.5 16.3 15.5 11 24 11z" fill="#ef4444"/>' +
         '<path d="M14.5 22.5l7.5 1.2-6.3 3.2z" fill="#fde047"/><path d="M33.5 22.5l-7.5 1.2 6.3 3.2z" fill="#fde047"/>' +
         '<path d="M17 30.5q7 4.8 14 0l-1.4 3.2q-5.6 3.2-11.2 0z" fill="#7f1d1d"/>' +
         '<path d="M19.2 31.6l1.7 3.4 1.7-3zM28.8 31.6l-1.7 3.4-1.7-3z" fill="#fff"/>' +
         '<path d="M21.8 39h4.4L24 44z" fill="#991b1b"/>' },
  { id: 'chipmunk', name: 'Aigüe / Écureuil', emoji: '🐿️', pitch: 7, effects: [],
    color: '#f59e0b', desc: 'Très aigu',
    svg: '<circle cx="14" cy="12" r="6" fill="#d97706"/><circle cx="34" cy="12" r="6" fill="#d97706"/>' +
         '<circle cx="14" cy="12" r="2.6" fill="#fbbf24"/><circle cx="34" cy="12" r="2.6" fill="#fbbf24"/>' +
         '<ellipse cx="24" cy="26" rx="15" ry="14" fill="#f59e0b"/>' +
         '<circle cx="13.5" cy="28" r="4" fill="#fbbf24"/><circle cx="34.5" cy="28" r="4" fill="#fbbf24"/>' +
         '<circle cx="18" cy="22" r="2.2" fill="#1a1c20"/><circle cx="30" cy="22" r="2.2" fill="#1a1c20"/>' +
         '<circle cx="24" cy="27.5" r="2" fill="#78350f"/>' +
         '<rect x="20.4" y="30.5" width="3.4" height="6.5" rx="1.2" fill="#fff"/>' +
         '<rect x="24.2" y="30.5" width="3.4" height="6.5" rx="1.2" fill="#fff"/>' },
  { id: 'child', name: 'Enfant', emoji: '🧒', pitch: 4, effects: [],
    color: '#fb7185', desc: 'Aigu léger',
    svg: '<circle cx="24" cy="26" r="15" fill="#ffcdb8"/>' +
         '<path d="M24 11q-1.5-5.5 4.5-6.5" fill="none" stroke="#9a5b3c" stroke-width="3" stroke-linecap="round"/>' +
         '<circle cx="18.5" cy="24" r="2.4" fill="#1a1c20"/><circle cx="29.5" cy="24" r="2.4" fill="#1a1c20"/>' +
         '<circle cx="14" cy="29" r="3" fill="#fb7185" opacity=".55"/><circle cx="34" cy="29" r="3" fill="#fb7185" opacity=".55"/>' +
         '<path d="M19 31.5q5 4.5 10 0" fill="none" stroke="#b45309" stroke-width="2.6" stroke-linecap="round"/>' },
  { id: 'robot', name: 'Robot', emoji: '🤖', pitch: 0, effects: [{ t: 'robot', freq: 60 }, { t: 'distortion', amount: 4 }],
    color: '#22d3ee', desc: 'Vibration métallique',
    svg: '<line x1="24" y1="5" x2="24" y2="9" stroke="#67e8f9" stroke-width="3" stroke-linecap="round"/>' +
         '<circle cx="24" cy="4.5" r="2.5" fill="#a5f3fc"/>' +
         '<rect x="5.5" y="18" width="4" height="9" rx="2" fill="#0e7490"/><rect x="38.5" y="18" width="4" height="9" rx="2" fill="#0e7490"/>' +
         '<rect x="9" y="9" width="30" height="27" rx="7" fill="#0891b2"/>' +
         '<rect x="12.5" y="13" width="23" height="12" rx="5" fill="#164e63"/>' +
         '<circle cx="18.5" cy="19" r="3.4" fill="#a5f3fc"/><circle cx="29.5" cy="19" r="3.4" fill="#a5f3fc"/>' +
         '<rect x="16" y="28.5" width="16" height="4.5" rx="2.25" fill="#164e63"/>' +
         '<line x1="20.5" y1="28.5" x2="20.5" y2="33" stroke="#67e8f9" stroke-width="1.6"/>' +
         '<line x1="24" y1="28.5" x2="24" y2="33" stroke="#67e8f9" stroke-width="1.6"/>' +
         '<line x1="27.5" y1="28.5" x2="27.5" y2="33" stroke="#67e8f9" stroke-width="1.6"/>' },
  { id: 'cyborg', name: 'Cyborg', emoji: '🦾', pitch: -3, effects: [{ t: 'robot', freq: 30 }, { t: 'reverb', mix: 0.25, seconds: 1.2 }],
    color: '#94a3b8', desc: 'Métal + écho',
    svg: '<rect x="10" y="9" width="28" height="30" rx="8" fill="#94a3b8"/>' +
         '<path d="M24 9h6a8 8 0 0 1 8 8v14a8 8 0 0 1-8 8h-6z" fill="#475569"/>' +
         '<circle cx="34.5" cy="13.5" r="1.2" fill="#cbd5e1"/><circle cx="34.5" cy="34.5" r="1.2" fill="#cbd5e1"/>' +
         '<circle cx="17.5" cy="22" r="3.2" fill="#f8fafc"/><circle cx="17.5" cy="22" r="1.5" fill="#0f172a"/>' +
         '<circle cx="30.5" cy="22" r="4.8" fill="none" stroke="#f87171" stroke-width="1.8"/>' +
         '<circle cx="30.5" cy="22" r="2.2" fill="#ef4444"/>' +
         '<line x1="15.5" y1="32" x2="27" y2="32" stroke="#1e293b" stroke-width="2.6" stroke-linecap="round"/>' },
  { id: 'cathedral', name: 'Cathédrale', emoji: '⛪', pitch: 0, effects: [{ t: 'reverb', mix: 0.55, seconds: 4.5 }],
    color: '#eab308', desc: 'Grande réverb',
    svg: '<path d="M10 41V23l5-5 5 5v18z" fill="#a16207"/><path d="M28 41V23l5-5 5 5v18z" fill="#a16207"/>' +
         '<rect x="13.7" y="26" width="2.6" height="5" rx="1.2" fill="#fde047"/><rect x="31.7" y="26" width="2.6" height="5" rx="1.2" fill="#fde047"/>' +
         '<path d="M17 41V17l7-8.5 7 8.5v24z" fill="#eab308"/>' +
         '<line x1="24" y1="3" x2="24" y2="8.5" stroke="#fde047" stroke-width="2.4" stroke-linecap="round"/>' +
         '<line x1="21.6" y1="5.2" x2="26.4" y2="5.2" stroke="#fde047" stroke-width="2.4" stroke-linecap="round"/>' +
         '<circle cx="24" cy="21" r="3.2" fill="#fef3c7"/>' +
         '<path d="M20.5 41v-6.5a3.5 3.5 0 0 1 7 0V41z" fill="#713f12"/>' },
  { id: 'cave', name: 'Grotte / Écho', emoji: '🕳️', pitch: -2, effects: [{ t: 'echo', time: 0.28, feedback: 0.45, mix: 0.5 }],
    color: '#a1887f', desc: 'Écho répété',
    svg: '<path d="M7 41V29C7 18 14.5 10.5 24 10.5S41 18 41 29v12h-8v-9.5a9 9 0 0 0-18 0V41z" fill="#8d6e63"/>' +
         '<path d="M12 15.5l3.5 3M36 15.5l-3.5 3" stroke="#6d4c41" stroke-width="2.4" stroke-linecap="round"/>' +
         '<rect x="22.7" y="27" width="2.6" height="10" rx="1.3" fill="#efe6e1"/>' +
         '<rect x="18.2" y="30" width="2.6" height="7" rx="1.3" fill="#cbb8ae"/>' +
         '<rect x="27.2" y="30" width="2.6" height="7" rx="1.3" fill="#cbb8ae"/>' },
  { id: 'radio', name: 'Radio', emoji: '📻', pitch: 0, effects: [{ t: 'radio' }, { t: 'distortion', amount: 6 }],
    color: '#a855f7', desc: 'Vieux poste FM',
    svg: '<line x1="30" y1="16" x2="38" y2="6.5" stroke="#d8b4fe" stroke-width="2.6" stroke-linecap="round"/>' +
         '<circle cx="38.5" cy="6" r="1.8" fill="#d8b4fe"/>' +
         '<rect x="7" y="16" width="34" height="24" rx="5" fill="#9333ea"/>' +
         '<rect x="7" y="16" width="34" height="5" rx="2.5" fill="#7e22ce"/>' +
         '<circle cx="18" cy="30" r="6.5" fill="#6b21a8"/><circle cx="18" cy="30" r="3" fill="#d8b4fe"/>' +
         '<circle cx="32" cy="27" r="3.8" fill="#e9d5ff"/>' +
         '<line x1="32" y1="27" x2="34.3" y2="24.7" stroke="#6b21a8" stroke-width="1.8" stroke-linecap="round"/>' +
         '<rect x="27.5" y="33" width="9" height="3" rx="1.5" fill="#6b21a8"/>' },
  { id: 'phone', name: 'Téléphone', emoji: '📞', pitch: 0, effects: [{ t: 'phone' }],
    color: '#34d399', desc: 'Son compressé',
    svg: '<path d="M10.5 13.5c-2.9 2.9-2.9 7.6 0 10.5l13.5 13.5c2.9 2.9 7.6 2.9 10.5 0l2-2c1.7-1.7 1.4-4.6-.7-5.9l-4.6-2.9c-1.5-1-3.5-.8-4.8.5l-.8.8-6.6-6.6.8-.8c1.3-1.3 1.5-3.3.5-4.8l-2.9-4.6c-1.3-2.1-4.2-2.4-5.9-.7z" fill="#10b981"/>' +
         '<path d="M30 11a8.5 8.5 0 0 1 7 7" fill="none" stroke="#6ee7b7" stroke-width="2.6" stroke-linecap="round"/>' +
         '<path d="M31.5 4.5A15 15 0 0 1 43.5 16" fill="none" stroke="#6ee7b7" stroke-width="2.6" stroke-linecap="round"/>' },
  { id: 'walkie', name: 'Talkie-walkie', emoji: '🔊', pitch: 0, effects: [{ t: 'radio' }, { t: 'distortion', amount: 10 }, { t: 'tremolo', rate: 0 }],
    color: '#84cc16', desc: 'Radio saturée',
    svg: '<rect x="14" y="4" width="3.2" height="10" rx="1.6" fill="#4d7c0f"/>' +
         '<path d="M25 9a8 8 0 0 1 5 4" fill="none" stroke="#bef264" stroke-width="2.2" stroke-linecap="round"/>' +
         '<path d="M27.5 4.5a13 13 0 0 1 8 6.5" fill="none" stroke="#bef264" stroke-width="2.2" stroke-linecap="round"/>' +
         '<rect x="10" y="12.5" width="20" height="30" rx="5" fill="#65a30d"/>' +
         '<line x1="14.5" y1="18.5" x2="25.5" y2="18.5" stroke="#365314" stroke-width="2.2" stroke-linecap="round"/>' +
         '<line x1="14.5" y1="22.5" x2="25.5" y2="22.5" stroke="#365314" stroke-width="2.2" stroke-linecap="round"/>' +
         '<line x1="14.5" y1="26.5" x2="25.5" y2="26.5" stroke="#365314" stroke-width="2.2" stroke-linecap="round"/>' +
         '<rect x="14" y="31.5" width="12" height="6.5" rx="2.2" fill="#365314"/>' +
         '<circle cx="34" cy="20" r="2.6" fill="#a3e635"/>' },
  { id: 'alien', name: 'Alien', emoji: '👽', pitch: 3, effects: [{ t: 'tremolo', rate: 6, depth: 0.6 }, { t: 'reverb', mix: 0.3, seconds: 1.5 }],
    color: '#4ade80', desc: 'Modulation spatiale',
    svg: '<path d="M24 5c9.5 0 16 6.5 16 15 0 10-9.5 19.5-16 23C17.5 39.5 8 30 8 20 8 11.5 14.5 5 24 5z" fill="#4ade80"/>' +
         '<path d="M13 19.5c5-3.2 9.5-1.6 10.5 3.2-4.2 3.2-9.5 1-10.5-3.2z" fill="#052e16"/>' +
         '<path d="M35 19.5c-5-3.2-9.5-1.6-10.5 3.2 4.2 3.2 9.5 1 10.5-3.2z" fill="#052e16"/>' +
         '<circle cx="22.6" cy="30.5" r=".9" fill="#052e16"/><circle cx="25.4" cy="30.5" r=".9" fill="#052e16"/>' +
         '<path d="M21 35h6" fill="none" stroke="#052e16" stroke-width="2" stroke-linecap="round"/>' },
  { id: 'ghost', name: 'Fantôme', emoji: '👻', pitch: -4, effects: [{ t: 'tremolo', rate: 4, depth: 0.5 }, { t: 'reverb', mix: 0.5, seconds: 3 }],
    color: '#a78bfa', desc: 'Tremblant + réverb',
    svg: '<path d="M24 5c-9 0-14.5 7-14.5 15.5V42l4.8-4 4.9 4 4.8-4 4.9 4 4.8-4 4.8 4V20.5C38.5 12 33 5 24 5z" fill="#ddd6fe"/>' +
         '<ellipse cx="19" cy="20" rx="2.4" ry="3.4" fill="#312e81"/><ellipse cx="29" cy="20" rx="2.4" ry="3.4" fill="#312e81"/>' +
         '<ellipse cx="24" cy="28.5" rx="2.6" ry="3.4" fill="#312e81"/>' +
         '<circle cx="15" cy="14" r="4.5" fill="#fff" opacity=".35"/>' },

  // ----- Nouveaux presets -----
  { id: 'vador', name: 'Dark Vador', emoji: '🖤', pitch: -7, color: '#374151', desc: 'Grave + respiration métallique',
    effects: [{ t: 'distortion', amount: 3 }, { t: 'filter', type: 'lowpass', freq: 2600 }, { t: 'reverb', mix: 0.28, seconds: 1.4 }] },
  { id: 'helium', name: 'Hélium', emoji: '🎈', pitch: 10, color: '#f472b6', desc: 'Voix de ballon très aiguë',
    effects: [{ t: 'filter', type: 'highshelf', freq: 3000, gain: 4 }] },
  { id: 'underwater', name: 'Sous l\'eau', emoji: '🌊', pitch: -1, color: '#22d3ee', desc: 'Étouffé + ondulant',
    effects: [{ t: 'filter', type: 'lowpass', freq: 900, q: 1.2 }, { t: 'tremolo', rate: 3, depth: 0.35 }, { t: 'reverb', mix: 0.3, seconds: 1.8 }] },
  { id: 'megaphone', name: 'Mégaphone', emoji: '📣', pitch: 0, color: '#f59e0b', desc: 'Annonce criée saturée',
    effects: [{ t: 'filter', type: 'peaking', freq: 1500, q: 1.5, gain: 10 }, { t: 'filter', type: 'highpass', freq: 500 }, { t: 'distortion', amount: 14 }] },
  { id: 'god', name: 'Voix de Dieu', emoji: '🌟', pitch: -3, color: '#fcd34d', desc: 'Grave + réverb céleste',
    effects: [{ t: 'chorus', mix: 0.4, voices: 3 }, { t: 'reverb', mix: 0.6, seconds: 5.5 }] },
  { id: 'choir', name: 'Chœur', emoji: '🎶', pitch: 0, color: '#818cf8', desc: 'Voix dédoublées',
    effects: [{ t: 'chorus', mix: 0.6, voices: 4 }, { t: 'reverb', mix: 0.35, seconds: 2 }] },
  { id: 'witch', name: 'Sorcière', emoji: '🧙', pitch: 5, color: '#a3e635', desc: 'Aigüe + ricanement caverneux',
    effects: [{ t: 'distortion', amount: 5 }, { t: 'echo', time: 0.22, feedback: 0.35, mix: 0.4 }, { t: 'reverb', mix: 0.35, seconds: 2.5 }] },
  { id: 'giant', name: 'Géant', emoji: '🗿', pitch: -10, color: '#78716c', desc: 'Très grave et massif',
    effects: [{ t: 'filter', type: 'lowshelf', freq: 200, gain: 6 }, { t: 'reverb', mix: 0.3, seconds: 2.2 }] },
  { id: 'vinyl', name: 'Vieux disque', emoji: '🎙️', pitch: 0, color: '#d6a45f', desc: 'Radio d\'époque nasillarde',
    effects: [{ t: 'filter', type: 'highpass', freq: 400 }, { t: 'filter', type: 'lowpass', freq: 3200 }, { t: 'tremolo', rate: 8, depth: 0.15 }] },
  { id: 'military', name: 'Radio militaire', emoji: '🪖', pitch: 0, color: '#4d7c0f', desc: 'Talkie brouillé + saturé',
    effects: [{ t: 'radio' }, { t: 'distortion', amount: 16 }, { t: 'filter', type: 'lowpass', freq: 2800 }] },
];

/* ========== Générateurs de nœuds d'effets ========== */

// Réverb : convolution avec une impulsion synthétique (bruit décroissant)
function makeReverb(ctx, mix, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
  }
  const conv = ctx.createConvolver();
  conv.buffer = buf;
  const wet = ctx.createGain(); wet.gain.value = mix;
  const dry = ctx.createGain(); dry.gain.value = 1 - mix * 0.6;
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(dry); dry.connect(output);
  input.connect(conv); conv.connect(wet); wet.connect(output);
  return { input, output };
}

// Écho : delay avec réinjection
function makeEcho(ctx, time, feedback, mix) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const delay = ctx.createDelay(2.0);
  delay.delayTime.value = time;
  const fb = ctx.createGain(); fb.gain.value = feedback;
  const wet = ctx.createGain(); wet.gain.value = mix;
  input.connect(output);                 // signal direct
  input.connect(delay);
  delay.connect(fb); fb.connect(delay);  // boucle de réinjection
  delay.connect(wet); wet.connect(output);
  return { input, output };
}

// Robot : modulation en anneau (ring modulation) via un oscillateur
function makeRobot(ctx, freq) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const ring = ctx.createGain();
  ring.gain.value = 0;                    // la porteuse module ce gain
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = freq;
  osc.connect(ring.gain);
  osc.start();
  input.connect(ring); ring.connect(output);
  return { input, output, _osc: osc };
}

// Distorsion douce (waveshaper)
function makeDistortion(ctx, amount) {
  const input = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const n = 44100;
  const curve = new Float32Array(n);
  const k = amount;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * Math.PI / 180) / (Math.PI + k * Math.abs(x));
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  const output = ctx.createGain(); output.gain.value = 0.8;
  input.connect(shaper); shaper.connect(output);
  return { input, output };
}

// Trémolo : modulation d'amplitude (voix "ondulante")
function makeTremolo(ctx, rate, depth) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const amp = ctx.createGain(); amp.gain.value = 1 - depth;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = rate || 5;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = depth || 0.5;
  lfo.connect(lfoGain); lfoGain.connect(amp.gain);
  lfo.start();
  input.connect(amp); amp.connect(output);
  return { input, output, _osc: lfo };
}

// Radio : passe-bande étroit (son "grésillant"/AM)
function makeRadio(ctx) {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
  const peak = ctx.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 1800; peak.gain.value = 8; peak.Q.value = 2;
  const output = ctx.createGain(); output.gain.value = 1.4;
  input.connect(hp); hp.connect(lp); lp.connect(peak); peak.connect(output);
  return { input, output };
}

// Téléphone : bande passante téléphonique 300–3400 Hz
function makePhone(ctx) {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300; hp.Q.value = 0.7;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400; lp.Q.value = 0.7;
  const output = ctx.createGain(); output.gain.value = 1.3;
  input.connect(hp); hp.connect(lp); lp.connect(output);
  return { input, output };
}

// Filtre biquad générique (passe-bas/haut/peak) — pour mégaphone, sous l'eau, etc.
function makeFilter(ctx, type, freq, q, gain) {
  const input = ctx.createGain();
  const f = ctx.createBiquadFilter();
  f.type = type || 'lowpass';
  f.frequency.value = freq ?? 1000;
  if (q != null) f.Q.value = q;
  if (gain != null && (type === 'peaking' || type === 'lowshelf' || type === 'highshelf')) f.gain.value = gain;
  const output = ctx.createGain();
  input.connect(f); f.connect(output);
  return { input, output };
}

// Chœur : dédouble la voix avec de légers retards désaccordés (voix multiple)
function makeChorus(ctx, mix, voices) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1 - (mix ?? 0.5);
  input.connect(dry); dry.connect(output);
  const n = voices ?? 3;
  for (let i = 0; i < n; i++) {
    const delay = ctx.createDelay(); delay.delayTime.value = 0.012 + i * 0.008;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.15 + i * 0.07;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.002;
    lfo.connect(lfoGain); lfoGain.connect(delay.delayTime); lfo.start();
    const wet = ctx.createGain(); wet.gain.value = (mix ?? 0.5) / n;
    input.connect(delay); delay.connect(wet); wet.connect(output);
  }
  return { input, output };
}

function makeEffect(ctx, spec) {
  switch (spec.t) {
    case 'reverb': return makeReverb(ctx, spec.mix ?? 0.4, spec.seconds ?? 2);
    case 'echo': return makeEcho(ctx, spec.time ?? 0.25, spec.feedback ?? 0.4, spec.mix ?? 0.5);
    case 'robot': return makeRobot(ctx, spec.freq ?? 50);
    case 'distortion': return makeDistortion(ctx, spec.amount ?? 6);
    case 'tremolo': return makeTremolo(ctx, spec.rate ?? 5, spec.depth ?? 0.5);
    case 'radio': return makeRadio(ctx);
    case 'phone': return makePhone(ctx);
    case 'filter': return makeFilter(ctx, spec.type, spec.freq, spec.q, spec.gain);
    case 'chorus': return makeChorus(ctx, spec.mix, spec.voices);
    default: return null;
  }
}

/* ========== Classe VoiceFX ========== */
class VoiceFX {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();     // point d'entrée fixe (le micro s'y branche)
    this.output = ctx.createGain();    // point de sortie fixe (va vers le câble)
    this.stNode = null;                // nœud SoundTouch (pitch), si disponible
    this.stReady = false;
    this._effectNodes = [];
    this._built = false;
  }

  // Charge le worklet SoundTouch (une seule fois). Sans lui, le pitch est ignoré.
  async initPitch(processorUrl) {
    try {
      await window.SoundTouchNode.register(this.ctx, processorUrl);
      this.stNode = new window.SoundTouchNode({ context: this.ctx, outputChannelCount: 1 });
      this.stReady = true;
    } catch (e) {
      console.warn('SoundTouch indisponible, pitch désactivé :', e);
      this.stReady = false;
    }
  }

  // (Re)construit la chaîne pour un preset donné.
  // opts.live = true : garde le nœud pitch ET un filtre de timbre TOUJOURS branchés,
  // pour que le pad XY puisse les moduler en continu sans reconstruire la chaîne.
  applyPreset(preset, opts = {}) {
    const ctx = this.ctx;
    // déconnecte l'ancienne chaîne
    try { this.input.disconnect(); } catch {}
    if (this.stNode) { try { this.stNode.disconnect(); } catch {} }
    if (this._timbre) { try { this._timbre.disconnect(); } catch {} this._timbre = null; }
    for (const n of this._effectNodes) {
      try { n.output.disconnect(); } catch {}
      if (n._osc) { try { n._osc.stop(); } catch {} }
    }
    this._effectNodes = [];
    this._live = !!opts.live;

    let cursor = this.input;

    // 1) Pitch (SoundTouch) si dispo. En mode live, toujours branché (même pitch 0).
    if (this.stReady && this.stNode) {
      const semis = preset.pitch || 0;
      try { this.stNode.pitchSemitones.value = semis; } catch {}
      if (semis !== 0 || this._live) {
        cursor.connect(this.stNode);
        cursor = this.stNode;
      }
    }

    // 1b) Filtre de timbre modulable (pad XY) — un peaking dont on bougera la fréquence
    if (this._live) {
      const t = ctx.createBiquadFilter();
      t.type = 'peaking'; t.frequency.value = 1500; t.Q.value = 1; t.gain.value = 0;
      cursor.connect(t); cursor = t;
      this._timbre = t;
    }

    // 2) Effets en série
    for (const spec of preset.effects || []) {
      const node = makeEffect(ctx, spec);
      if (!node) continue;
      cursor.connect(node.input);
      cursor = node.output;
      this._effectNodes.push(node);
    }

    // 3) Vers la sortie
    cursor.connect(this.output);
    this._built = true;
  }

  // Pilotage temps réel du pad XY (sans reconstruire la chaîne)
  // pitch : demi-tons (-12..+12) · timbre : -1 (sombre) .. +1 (brillant)
  setXY(pitch, timbre) {
    if (this.stReady && this.stNode) { try { this.stNode.pitchSemitones.value = pitch; } catch {} }
    if (this._timbre) {
      const now = this.ctx.currentTime;
      // timbre -> gain d'un peaking centré vers l'aigu : +brillant = boost aigus
      try {
        this._timbre.frequency.setTargetAtTime(1200 + timbre * 1400, now, 0.02);
        this._timbre.gain.setTargetAtTime(timbre * 9, now, 0.02);
      } catch {}
    }
  }

  destroy() {
    try { this.input.disconnect(); } catch {}
    if (this.stNode) { try { this.stNode.disconnect(); } catch {} }
    for (const n of this._effectNodes) {
      try { n.output.disconnect(); } catch {}
      if (n._osc) { try { n._osc.stop(); } catch {} }
    }
    this._effectNodes = [];
  }
}

window.VOICE_PRESETS = VOICE_PRESETS;
window.VoiceFX = VoiceFX;
