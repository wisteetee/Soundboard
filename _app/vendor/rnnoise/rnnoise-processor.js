/*
 * Suppresseur de bruit par IA (RNNoise) — AudioWorklet.
 * RNNoise est un réseau de neurones (GRU) entraîné à reconnaître la voix humaine
 * et supprimer TOUT le reste (clavier, portes, chien, ventilo…), même les bruits
 * forts — contrairement à un simple noise gate. C'est la technique de Krisp.
 *
 * Contraintes RNNoise : frames de 480 échantillons, 48 kHz, échelle int16.
 * Le worklet reçoit des blocs de 128 : on accumule dans un buffer, on traite par
 * frames de 480, et on ré-émet avec la latence induite (~10-13 ms).
 *
 * Le module WASM (rnnoise-sync.js) est chargé AVANT ce fichier via addModule ;
 * il expose globalThis.createRNNWasmModuleSync.
 */
const RN_FRAME = 480;      // taille de frame imposée par RNNoise
const RN_SR = 48000;       // RNNoise attend du 48 kHz

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.mix = 1;           // 1 = 100% débruité, 0 = signal original (dry/wet)
    this.ready = false;
    this.lastVad = 0;       // dernière probabilité de voix (0..1) renvoyée par RNNoise

    // Gate VAD : RNNoise seul laisse passer clavier/bruits de bouche (proches de la
    // voix). On COUPE quand la probabilité de voix (VAD) est basse -> silence propre
    // entre les phrases. gateStrength 0 = pas de gate, 1 = gate agressif.
    this.gateStrength = 0.7;
    this.gateGain = 0;      // gain lissé du gate (0 fermé .. 1 ouvert)

    try {
      const Module = globalThis.createRNNWasmModuleSync();
      this._initWasm(Module);
    } catch (e) {
      // si le WASM échoue, on laisse passer le signal tel quel (jamais de blocage)
      this.port.postMessage({ error: String(e && e.message || e) });
    }

    // buffers d'accumulation entrée/sortie
    this.inBuf = new Float32Array(RN_FRAME * 4);
    this.inLen = 0;
    this.outBuf = new Float32Array(RN_FRAME * 8);
    this.outStart = 0;
    this.outLen = 0;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
      if (typeof d.mix === 'number') this.mix = Math.max(0, Math.min(1, d.mix));
      if (typeof d.gate === 'number') this.gateStrength = Math.max(0, Math.min(1, d.gate));
    };
  }

  _initWasm(Module) {
    this.M = Module;
    this.state = Module._rnnoise_create(0);
    // tampon WASM pour une frame (float32)
    this.ptr = Module._malloc(RN_FRAME * 4);
    this.heap = Module.HEAPF32;
    this.ready = true;
  }

  // traite une frame de 480 échantillons (float -1..1) -> renvoie la frame débruitée
  _processFrame(frame) {
    const M = this.M, ptr = this.ptr, base = ptr >> 2;
    // RNNoise travaille en échelle int16
    for (let i = 0; i < RN_FRAME; i++) M.HEAPF32[base + i] = frame[i] * 32768;
    const vad = M._rnnoise_process_frame(this.state, ptr, ptr);
    this.lastVad = vad;
    const out = new Float32Array(RN_FRAME);
    for (let i = 0; i < RN_FRAME; i++) out[i] = M.HEAPF32[base + i] / 32768;
    return out;
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const inCh = input[0], outCh = output[0];
    const n = inCh.length;

    if (!this.enabled || !this.ready) { outCh.set(inCh); return true; }

    // 1. accumule l'entrée
    if (this.inLen + n > this.inBuf.length) {
      const bigger = new Float32Array(this.inBuf.length * 2);
      bigger.set(this.inBuf.subarray(0, this.inLen));
      this.inBuf = bigger;
    }
    this.inBuf.set(inCh, this.inLen);
    this.inLen += n;

    // 2. traite toutes les frames complètes disponibles
    while (this.inLen >= RN_FRAME) {
      const frame = this.inBuf.subarray(0, RN_FRAME);
      const dry = new Float32Array(frame);           // copie du signal original
      const wet = this._processFrame(frame);         // signal débruité (met à jour lastVad)

      // Gate VAD : cible = ouvert si RNNoise détecte de la voix, sinon fermé.
      // Le seuil monte avec gateStrength (plus agressif = coupe plus).
      const thresh = 0.25 + this.gateStrength * 0.5;   // 0.25 .. 0.75
      const target = this.lastVad > thresh ? 1 : 0;
      // rampe LISSE par échantillon (évite les clics) : ouverture rapide, fermeture douce
      const rate = target > this.gateGain ? 0.06 : 0.004;   // par échantillon
      const floor = (1 - this.gateStrength) * 0.15;         // résidu à gate fermé

      const res = new Float32Array(RN_FRAME);
      for (let i = 0; i < RN_FRAME; i++) {
        this.gateGain += (target - this.gateGain) * rate;
        const g = this.gateStrength <= 0 ? 1 : (this.gateGain + (1 - this.gateGain) * floor);
        res[i] = (wet[i] * this.mix + dry[i] * (1 - this.mix)) * g;
      }
      // pousse dans la file de sortie
      if (this.outStart + this.outLen + RN_FRAME > this.outBuf.length) {
        // compacte
        this.outBuf.copyWithin(0, this.outStart, this.outStart + this.outLen);
        this.outStart = 0;
        if (this.outLen + RN_FRAME > this.outBuf.length) {
          const bigger = new Float32Array((this.outLen + RN_FRAME) * 2);
          bigger.set(this.outBuf.subarray(0, this.outLen));
          this.outBuf = bigger;
        }
      }
      this.outBuf.set(res, this.outStart + this.outLen);
      this.outLen += RN_FRAME;
      // retire la frame consommée de l'entrée
      this.inBuf.copyWithin(0, RN_FRAME, this.inLen);
      this.inLen -= RN_FRAME;
    }

    // 3. sort n échantillons débruités (silence tant que la latence n'est pas comblée)
    if (this.outLen >= n) {
      outCh.set(this.outBuf.subarray(this.outStart, this.outStart + n));
      this.outStart += n;
      this.outLen -= n;
    } else {
      outCh.fill(0);   // amorçage : ~10 ms de silence au tout début
    }

    // copie mono -> autres canaux
    for (let c = 1; c < output.length; c++) output[c].set(outCh);
    return true;
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
