/**
 * @fileoverview Presentation hook managing floating completion toasts and notification sound cues.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createNotificationSoundPlayer } from '../../data/notificationSound.js';
import { useStudioServices } from '../StudioContext.jsx';

const MAX_VISIBLE_TOASTS = 3;
const SUCCESS_AUTO_DISMISS_MS = 5000;
const ERROR_AUTO_DISMISS_MS = 7500;

/**
 * Coordinates toast popup queue, auto-dismiss timers, and Web Audio sound mute toggle.
 * Inputs: none (consumes optional `notificationSound` adapter from Studio context).
 * Outputs: `{ toasts, soundMuted, notify, dismiss, toggleSoundMuted, unlockSound }`.
 * Side effects: schedules dismiss timers (cleared on unmount) and triggers audio cues when unmuted.
 * Failure modes: degrades cleanly if Web Audio or timers are unavailable.
 * @returns {object} Notification state and handlers.
 */
export function useNotifications() {
  const services = useStudioServices();
  const isOwnedSoundPlayer = !services?.notificationSound;
  const soundPlayer = useMemo(
    () => services?.notificationSound || createNotificationSoundPlayer({ logger: services?.logger }),
    [services]
  );
  const [toasts, setToasts] = useState([]);
  const [soundMuted, setSoundMuted] = useState(() => Boolean(soundPlayer.isMuted?.()));
  const toastsRef = useRef([]);
  const timersRef = useRef(new Map());
  const seqRef = useRef(0);

  const clearTimer = useCallback(id => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      globalThis.clearTimeout?.(timer);
      timersRef.current.delete(id);
    }
  }, []);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) {
      globalThis.clearTimeout?.(timer);
    }
    timersRef.current.clear();
    if (isOwnedSoundPlayer) soundPlayer.close?.();
  }, [isOwnedSoundPlayer, soundPlayer]);

  const dismiss = useCallback(id => {
    clearTimer(id);
    const next = toastsRef.current.filter(item => item.id !== id);
    toastsRef.current = next;
    setToasts(next);
  }, [clearTimer]);

  const unlockSound = useCallback(() => {
    soundPlayer.unlock?.();
  }, [soundPlayer]);

  const toggleSoundMuted = useCallback(() => {
    const next = !soundPlayer.isMuted?.();
    soundPlayer.setMuted?.(next);
    setSoundMuted(next);
    if (!next) {
      soundPlayer.unlock?.();
      void soundPlayer.play?.('success');
    }
  }, [soundPlayer]);

  const notify = useCallback(({ kind = 'success', title, message }) => {
    const safeKind = kind === 'error' ? 'error' : 'success';
    const id = `toast-${++seqRef.current}`;
    const appended = [...toastsRef.current, { id, kind: safeKind, title: title || '', message: message || '' }];
    if (appended.length > MAX_VISIBLE_TOASTS) {
      for (const item of appended.slice(0, appended.length - MAX_VISIBLE_TOASTS)) clearTimer(item.id);
    }
    const next = appended.slice(-MAX_VISIBLE_TOASTS);
    toastsRef.current = next;
    setToasts(next);
    const ttl = safeKind === 'error' ? ERROR_AUTO_DISMISS_MS : SUCCESS_AUTO_DISMISS_MS;
    if (typeof globalThis.setTimeout === 'function') {
      const timer = globalThis.setTimeout(() => dismiss(id), ttl);
      timersRef.current.set(id, timer);
    }
    void soundPlayer.play?.(safeKind);
  }, [clearTimer, dismiss, soundPlayer]);

  return { toasts, soundMuted, notify, dismiss, toggleSoundMuted, unlockSound };
}
