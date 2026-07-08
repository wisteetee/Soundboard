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
const VOICE_PRESETS = [
  { id: 'none',      name: 'Normale',        emoji: '🎤', pitch: 0,  effects: [] },
  { id: 'deep',      name: 'Grave / Monstre',emoji: '👹', pitch: -6, effects: [] },
  { id: 'demon',     name: 'Démon',          emoji: '😈', pitch: -9, effects: [{ t: 'reverb', mix: 0.35, seconds: 2.2 }, { t: 'distortion', amount: 12 }] },
  { id: 'chipmunk',  name: 'Aigüe / Écureuil',emoji: '🐿️', pitch: 7,  effects: [] },
  { id: 'child',     name: 'Enfant',         emoji: '🧒', pitch: 4,  effects: [] },
  { id: 'robot',     name: 'Robot',          emoji: '🤖', pitch: 0,  effects: [{ t: 'robot', freq: 60 }, { t: 'distortion', amount: 4 }] },
  { id: 'cyborg',    name: 'Cyborg',         emoji: '🦾', pitch: -3, effects: [{ t: 'robot', freq: 30 }, { t: 'reverb', mix: 0.25, seconds: 1.2 }] },
  { id: 'cathedral', name: 'Cathédrale',     emoji: '⛪', pitch: 0,  effects: [{ t: 'reverb', mix: 0.55, seconds: 4.5 }] },
  { id: 'cave',      name: 'Grotte / Écho',  emoji: '🕳️', pitch: -2, effects: [{ t: 'echo', time: 0.28, feedback: 0.45, mix: 0.5 }] },
  { id: 'radio',     name: 'Radio',          emoji: '📻', pitch: 0,  effects: [{ t: 'radio' }, { t: 'distortion', amount: 6 }] },
  { id: 'phone',     name: 'Téléphone',      emoji: '📞', pitch: 0,  effects: [{ t: 'phone' }] },
  { id: 'walkie',    name: 'Talkie-walkie',  emoji: '🔊', pitch: 0,  effects: [{ t: 'radio' }, { t: 'distortion', amount: 10 }, { t: 'tremolo', rate: 0 }] },
  { id: 'alien',     name: 'Alien',          emoji: '👽', pitch: 3,  effects: [{ t: 'tremolo', rate: 6, depth: 0.6 }, { t: 'reverb', mix: 0.3, seconds: 1.5 }] },
  { id: 'ghost',     name: 'Fantôme',        emoji: '👻', pitch: -4, effects: [{ t: 'tremolo', rate: 4, depth: 0.5 }, { t: 'reverb', mix: 0.5, seconds: 3 }] },
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

function makeEffect(ctx, spec) {
  switch (spec.t) {
    case 'reverb': return makeReverb(ctx, spec.mix ?? 0.4, spec.seconds ?? 2);
    case 'echo': return makeEcho(ctx, spec.time ?? 0.25, spec.feedback ?? 0.4, spec.mix ?? 0.5);
    case 'robot': return makeRobot(ctx, spec.freq ?? 50);
    case 'distortion': return makeDistortion(ctx, spec.amount ?? 6);
    case 'tremolo': return makeTremolo(ctx, spec.rate ?? 5, spec.depth ?? 0.5);
    case 'radio': return makeRadio(ctx);
    case 'phone': return makePhone(ctx);
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

  // (Re)construit la chaîne pour un preset donné
  applyPreset(preset) {
    const ctx = this.ctx;
    // déconnecte l'ancienne chaîne
    try { this.input.disconnect(); } catch {}
    if (this.stNode) { try { this.stNode.disconnect(); } catch {} }
    for (const n of this._effectNodes) {
      try { n.output.disconnect(); } catch {}
      if (n._osc) { try { n._osc.stop(); } catch {} }
    }
    this._effectNodes = [];

    let cursor = this.input;

    // 1) Pitch (SoundTouch) si dispo et non nul
    if (this.stReady && this.stNode) {
      const semis = preset.pitch || 0;
      try { this.stNode.pitchSemitones.value = semis; } catch {}
      if (semis !== 0) {
        cursor.connect(this.stNode);
        cursor = this.stNode;
      }
      // si pitch nul on saute le nœud pour économiser du CPU / éviter la latence
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
