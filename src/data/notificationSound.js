/**
 * @fileoverview Web Audio API completion chime & error tone adapter with persistent mute preference.
 */

const MUTE_STORAGE_KEY = 'voxcpm.notificationSoundMuted';
const PEAK_GAIN = 0.11;
const MIN_GAIN = 0.0001;

const SOUND_PATTERNS = Object.freeze({
  success: Object.freeze({
    type: 'sine',
    notes: [
      { freq: 523.25, offsetSec: 0, durationSec: 0.14 },
      { freq: 659.25, offsetSec: 0.09, durationSec: 0.22 },
    ],
  }),
  error: Object.freeze({
    type: 'triangle',
    notes: [
      { freq: 392.0, offsetSec: 0, durationSec: 0.16 },
      { freq: 293.66, offsetSec: 0.12, durationSec: 0.24 },
    ],
  }),
});

function resolveStorage(explicitStorage, logger) {
  if (explicitStorage !== undefined) return explicitStorage || null;
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch (err) {
    logger?.debug?.('notificationSound.resolveStorage', err?.message || 'LocalStorage unavailable');
    return null;
  }
}

function readMutedFlag(storage, logger) {
  if (!storage) return false;
  try {
    return storage.getItem(MUTE_STORAGE_KEY) === 'true';
  } catch (err) {
    logger?.warn?.('notificationSound.readMutedFlag', err?.message || 'Could not read mute flag');
    return false;
  }
}

function writeMutedFlag(storage, muted, logger) {
  if (!storage) return;
  try {
    storage.setItem(MUTE_STORAGE_KEY, muted ? 'true' : 'false');
  } catch (err) {
    logger?.warn?.('notificationSound.writeMutedFlag', err?.message || 'Could not write mute flag');
  }
}

function resolveAudioContextClass(explicitClass) {
  if (explicitClass) return explicitClass;
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

function needsContextResume(ctx) {
  return Boolean(ctx && ctx.state !== 'running' && ctx.state !== 'closed' && typeof ctx.resume === 'function');
}

function closeAudioContext(ctx, logger) {
  if (!ctx || ctx.state === 'closed' || typeof ctx.close !== 'function') return;
  try {
    Promise.resolve(ctx.close()).catch(err => logger?.debug?.('notificationSound.close', err?.message || 'AudioContext close failed'));
  } catch (err) {
    logger?.debug?.('notificationSound.close', err?.message || 'AudioContext close failed');
  }
}

function scheduleTone(ctx, { type, freq, startAt, durationSec }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  gain.gain.setValueAtTime(MIN_GAIN, startAt);
  gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(MIN_GAIN, startAt + durationSec);
  osc.connect(gain);
  gain.connect(ctx.destination);
  if ('onended' in osc) {
    osc.onended = () => {
      osc.disconnect?.();
      gain.disconnect?.();
    };
  }
  osc.start(startAt);
  osc.stop(startAt + durationSec + 0.02);
}

/**
 * Creates a Web Audio notification cue player with persistent mute state.
 * Inputs: optional `{ AudioContextClass, storage, logger }`.
 * Outputs: `{ isMuted(), setMuted(bool), unlock(), play(kind), close() }`.
 * Side effects: stores mute preference in `localStorage` and synthesizes short audio cues via Web Audio.
 * Failure modes: degrades cleanly to no-op if Web Audio or storage is unavailable.
 * @param {{ AudioContextClass?: typeof AudioContext, storage?: Storage, logger?: { warn?: Function, debug?: Function } }} [deps] - Adapter dependencies.
 * @returns {object} Notification sound controller.
 */
export function createNotificationSoundPlayer({ AudioContextClass, storage, logger = null } = {}) {
  const activeStorage = resolveStorage(storage, logger);
  let muted = readMutedFlag(activeStorage, logger);
  let audioCtx = null;

  const ensureContext = () => {
    if (audioCtx && audioCtx.state !== 'closed') return audioCtx;
    audioCtx = null;
    const Ctor = resolveAudioContextClass(AudioContextClass);
    if (!Ctor) return null;
    try {
      audioCtx = new Ctor();
      return audioCtx;
    } catch (err) {
      logger?.debug?.('notificationSound.ensureContext', err?.message || 'AudioContext init failed');
      return null;
    }
  };

  return {
    isMuted: () => muted,

    setMuted(nextMuted) {
      muted = Boolean(nextMuted);
      writeMutedFlag(activeStorage, muted, logger);
      return muted;
    },

    unlock() {
      if (muted) return;
      const ctx = ensureContext();
      if (!needsContextResume(ctx)) return;
      try {
        Promise.resolve(ctx.resume()).catch(err => logger?.debug?.('notificationSound.unlock', err?.message || 'AudioContext resume failed'));
      } catch (err) {
        logger?.debug?.('notificationSound.unlock', err?.message || 'AudioContext resume failed');
      }
    },

    async play(kind = 'success') {
      if (muted) return false;
      const pattern = SOUND_PATTERNS[kind] || SOUND_PATTERNS.success;
      const ctx = ensureContext();
      if (!ctx) return false;
      try {
        if (needsContextResume(ctx)) await ctx.resume();
        if (ctx.state === 'closed') return false;
        const baseTime = Number(ctx.currentTime) || 0;
        for (const note of pattern.notes) {
          scheduleTone(ctx, { type: pattern.type, freq: note.freq, startAt: baseTime + note.offsetSec, durationSec: note.durationSec });
        }
        return true;
      } catch (err) {
        logger?.debug?.('notificationSound.play', err?.message || 'Sound playback failed');
        return false;
      }
    },

    close() {
      closeAudioContext(audioCtx, logger);
      audioCtx = null;
    },
  };
}
