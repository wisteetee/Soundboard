/*
 * Wrapper léger pour le processeur SoundTouch (AudioWorklet).
 * Adapté de @soundtouchjs/audio-worklet (MPL-2.0) — la constante PROCESSOR_NAME
 * est intégrée pour éviter les imports ES et permettre un chargement direct.
 */
(function () {
  'use strict';
  const PROCESSOR_NAME = 'soundtouch-processor';

  class SoundTouchNode extends AudioWorkletNode {
    static processorName = PROCESSOR_NAME;

    static async register(context, processorUrl) {
      await context.audioWorklet.addModule(processorUrl);
    }

    constructor({ context, sampleBufferType, interpolationStrategy, outputChannelCount } = {}) {
      super(context, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [outputChannelCount ?? 1],
        processorOptions: {
          sampleBufferType: sampleBufferType ?? 'circular',
          interpolationStrategy,
        },
      });
    }

    get pitch() { return this.parameters.get('pitch'); }
    get pitchSemitones() { return this.parameters.get('pitchSemitones'); }
    get playbackRate() { return this.parameters.get('playbackRate'); }
  }

  window.SoundTouchNode = SoundTouchNode;
})();
