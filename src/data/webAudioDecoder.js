/**
 * @fileoverview Web Audio API adapter implementing AudioDecoderPort using domain peak calculation.
 */

import { computePeaksFromSamples } from '../domain/audioValidation.js';

/**
 * Creates an AudioDecoderPort backed by browser AudioContext.
 * Inputs: optional `{ AudioContextClass }`.
 * Outputs: `{ decodePeaks(blob), decodeAudioSummary(blob) }`.
 * Side effects: opens and closes a transient `AudioContext` per decode call.
 * Failure modes: rejects if decoding fails or `AudioContext` is unavailable.
 * @param {{ AudioContextClass?: typeof AudioContext }} [deps] - Optional AudioContext constructor.
 * @returns {import('../domain/ports.js').AudioDecoderPort} Audio decoder adapter.
 */
export function createWebAudioDecoder({ AudioContextClass = globalThis.AudioContext } = {}) {
  /**
   * Decodes waveform peaks and duration from an audio Blob in a single pass.
   * @param {Blob} blob - Audio Blob to decode.
   * @returns {Promise<{ peaks: number[], duration: number }>} Decoded peaks and duration in seconds.
   */
  async function decodeAudioSummary(blob) {
    const decoder = new AudioContextClass();
    try {
      const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
      const duration = Number.isFinite(buffer.duration) && buffer.duration > 0 ? buffer.duration : 0;
      return { peaks: computePeaksFromSamples(buffer.getChannelData(0)), duration };
    } finally {
      await decoder.close();
    }
  }

  return {
    decodeAudioSummary,
    async decodePeaks(blob) {
      const { peaks } = await decodeAudioSummary(blob);
      return peaks;
    },
  };
}
