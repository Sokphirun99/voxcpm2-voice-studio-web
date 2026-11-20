/**
 * @fileoverview Presentation hook managing on-demand and optional automatic Whisper round-trip word QA for TTS audio.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveVerificationLanguage } from '../../domain/speechVerification.js';
import { useStudioServices } from '../StudioContext.jsx';

const INITIAL_VERIFICATION = Object.freeze({
  checking: false,
  result: null,
  error: '',
});

/**
 * Coordinates abortable round-trip speech verification (`POST /media_api/verify-speech`) for generated TTS recordings.
 * Inputs: `{ recording, autoVerify }`.
 * Outputs: `{ checking, result, error, canVerify, onVerify, onDismiss }`.
 * Side effects: posts generated WAV and expected script to `/media_api/verify-speech` on demand or after take completion when `autoVerify=true`.
 * Failure modes: translates network/service errors into inline `error` copy without blocking audio playback.
 * @param {{ recording: object|null, autoVerify?: boolean }} params - Verification hook inputs.
 * @returns {object} Verification UI state and actions.
 */
export function useSpeechVerification({ recording, autoVerify = false }) {
  const services = useStudioServices();
  const gateway = useMemo(() => services?.mediaSubtitleGateway || null, [services]);
  const abortRef = useRef(null);
  const seqRef = useRef(0);
  const seenRecordingIdRef = useRef(recording?.id || '');
  const autoVerifyRef = useRef(Boolean(autoVerify));
  autoVerifyRef.current = Boolean(autoVerify);
  const [state, setState] = useState(INITIAL_VERIFICATION);

  const recordingId = recording?.id || '';
  const hasVerifiableAudio = Boolean(recording?.blob && recording?.transcript?.trim());

  const runVerification = useCallback(async target => {
    if (!target?.blob || !target?.transcript?.trim()) return;
    if (typeof gateway?.verifySpeech !== 'function') {
      setState({ checking: false, result: null, error: 'Speech verification is unavailable in this environment.' });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++seqRef.current;
    setState({ checking: true, result: null, error: '' });
    try {
      const res = await gateway.verifySpeech({
        blob: target.blob,
        expectedText: target.transcript,
        language: resolveVerificationLanguage(target.transcript),
        fileName: target.seed != null ? `voxcpm2-${target.seed}.wav` : 'voxcpm2.wav',
        signal: controller.signal,
      });
      if (seq !== seqRef.current) return;
      setState({ checking: false, result: res, error: '' });
    } catch (err) {
      if (seq !== seqRef.current) return;
      if (err?.name === 'SynthesisCancelledError') {
        setState(INITIAL_VERIFICATION);
        return;
      }
      setState({ checking: false, result: null, error: err?.message || 'Could not verify spoken words.' });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [gateway]);

  useEffect(() => {
    const isFreshRecording = Boolean(recordingId && recordingId !== seenRecordingIdRef.current);
    seenRecordingIdRef.current = recordingId;
    abortRef.current?.abort();
    abortRef.current = null;
    seqRef.current += 1;
    setState(INITIAL_VERIFICATION);
    if (isFreshRecording && autoVerifyRef.current && hasVerifiableAudio) {
      void runVerification(recording);
    }
  }, [recordingId, hasVerifiableAudio, recording, runVerification]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const onVerify = useCallback(() => {
    if (!hasVerifiableAudio) return;
    void runVerification(recording);
  }, [hasVerifiableAudio, recording, runVerification]);

  const onDismiss = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    seqRef.current += 1;
    setState(INITIAL_VERIFICATION);
  }, []);

  return {
    checking: state.checking,
    result: state.result,
    error: state.error,
    canVerify: hasVerifiableAudio,
    onVerify,
    onDismiss,
  };
}
