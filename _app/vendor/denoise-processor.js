/*
 * Suppresseur de bruit micro « façon Krisp » — AudioWorklet.
 * Chaîne : high-pass léger (coupe rumble/respiration grave/ventilo)
 *          -> noise gate spectral adaptatif (coupe le souffle entre les phrases)
 *          -> expander doux (atténue ce qui reste sous le niveau de voix).
 *
 * Ne s'applique QUE sur le flux micro : les sons du soundboard passent par une
 * autre chaîne et ne le traversent jamais.
 *
 * Paramètres (via port.postMessage) :
 *   enabled     : bool  — actif ou bypass total
 *   strength    : 0..1   — agressivité (seuil du gate + profondeur d'atténuation)
 */
class DenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.strength = 0.6;

    // --- high-pass 1er ordre (~90 Hz) : enlève le grave de respiration/ventilo ---
    this.hpPrevIn = 0;
    this.hpPrevOut = 0;
    // coefficient RC pour ~90 Hz à 48 kHz
    this.hpAlpha = 0.985;

    // --- suivi du niveau de bruit de fond (plancher) et de l'enveloppe du signal ---
    this.noiseFloor = 0.003;   // s'adapte au bruit ambiant
    this.env = 0;              // enveloppe rapide du signal
    this.gate = 0;            // gain du gate courant (0 = fermé, 1 = ouvert), lissé

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
      if (typeof d.strength === 'number') this.strength = Math.max(0, Math.min(1, d.strength));
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;
    const inCh = input[0];
    const outCh = output[0];
    const n = inCh.length;

    if (!this.enabled) {
      outCh.set(inCh);
      return true;
    }

    // seuils dérivés de la force : plus « strength » est haut, plus le gate ferme tôt
    const openThresh = this.noiseFloor * (2.2 + this.strength * 3.5);   // ouvre au-dessus
    const closeThresh = this.noiseFloor * (1.4 + this.strength * 2.0);  // ferme en dessous
    const floorGain = 1 - this.strength * 0.92;  // atténuation résiduelle (≈ -22 dB à fond)
    const attack = 0.35;    // ouverture rapide (ne coupe pas les débuts de mots)
    const release = 0.015;  // fermeture douce (pas de « clic »)

    for (let i = 0; i < n; i++) {
      // 1) high-pass
      const x = inCh[i];
      const hp = this.hpAlpha * (this.hpPrevOut + x - this.hpPrevIn);
      this.hpPrevIn = x;
      this.hpPrevOut = hp;

      // 2) enveloppe rapide (valeur absolue lissée)
      const a = Math.abs(hp);
      this.env += (a - this.env) * (a > this.env ? 0.5 : 0.02);

      // 3) mise à jour lente du plancher de bruit quand le gate est fermé
      if (this.gate < 0.2) {
        this.noiseFloor += (this.env - this.noiseFloor) * 0.0008;
        if (this.noiseFloor < 0.0004) this.noiseFloor = 0.0004;
      }

      // 4) noise gate à hystérésis
      let target = this.gate;
      if (this.env > openThresh) target = 1;
      else if (this.env < closeThresh) target = 0;
      // lissage attack/release
      this.gate += (target - this.gate) * (target > this.gate ? attack : release);

      // gain final : entre floorGain (bruit) et 1 (voix)
      const g = floorGain + (1 - floorGain) * this.gate;
      outCh[i] = hp * g;
    }

    // copie mono -> autres canaux éventuels
    for (let c = 1; c < output.length; c++) output[c].set(outCh);
    return true;
  }
}

registerProcessor('denoise-processor', DenoiseProcessor);
