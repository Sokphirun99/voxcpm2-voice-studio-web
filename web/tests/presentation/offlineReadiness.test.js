/**
 * @fileoverview Presentation and SSR tests for Offline Readiness UI and preflight guards (R1-08).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { OFFLINE_STATUS, evaluateOfflineReadiness } from '../../src/domain/offlineReadiness.js';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function withViteSsr(run) {
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  try {
    return await run(vite);
  } finally {
    await vite.close();
  }
}

test('OfflineReadinessBadge renders accessible badge across all offline readiness states', async () => {
  await withViteSsr(async vite => {
    const { OfflineReadinessBadge } = await vite.ssrLoadModule('/src/presentation/components/OfflineReadinessBadge.jsx');

    // 1. Offline Ready state
    const readyReadiness = {
      status: OFFLINE_STATUS.OFFLINE_READY,
      label: 'Offline Ready',
      description: 'All required models are cached locally.',
      isOfflineReady: true,
    };
    const readyHtml = renderToStaticMarkup(
      React.createElement(OfflineReadinessBadge, { readiness: readyReadiness, onSelect() {} })
    );
    assert.ok(readyHtml.includes('id="offline-readiness-badge"'));
    assert.ok(readyHtml.includes('status-offline_ready'));
    assert.ok(readyHtml.includes('role="button"'));
    assert.ok(readyHtml.includes('tabindex="0"'));
    assert.ok(readyHtml.includes('aria-live="polite"'));
    assert.ok(readyHtml.includes('Offline Ready'));

    // 2. Downloads Required state
    const downloadsReadiness = {
      status: OFFLINE_STATUS.DOWNLOADS_REQUIRED,
      label: 'Downloads Required',
      description: '2 models require internet connection on first use.',
      isOfflineReady: false,
    };
    const downloadsHtml = renderToStaticMarkup(
      React.createElement(OfflineReadinessBadge, { readiness: downloadsReadiness })
    );
    assert.ok(downloadsHtml.includes('status-downloads_required'));
    assert.ok(downloadsHtml.includes('role="status"')); // Non-clickable has role="status"
    assert.ok(downloadsHtml.includes('Downloads Required'));

    // 3. Offline (Cached Features Available) state
    const cachedAvailableReadiness = {
      status: OFFLINE_STATUS.OFFLINE_CACHED_AVAILABLE,
      label: 'Offline (Cached Features Available)',
      description: 'Internet is disconnected. 4 cached features available.',
      isOfflineReady: false,
    };
    const cachedAvailableHtml = renderToStaticMarkup(
      React.createElement(OfflineReadinessBadge, { readiness: cachedAvailableReadiness })
    );
    assert.ok(cachedAvailableHtml.includes('status-offline_cached_available'));
    assert.ok(cachedAvailableHtml.includes('Offline (Cached Features Available)'));

    // 4. Missing readiness safely returns empty
    const nullHtml = renderToStaticMarkup(
      React.createElement(OfflineReadinessBadge, { readiness: null })
    );
    assert.equal(nullHtml, '');
  });
});

test('ModelsSetupWorkspace renders Offline (Cached Features Available) hero banner and Feature Offline Readiness panel', async () => {
  await withViteSsr(async vite => {
    const { ModelsSetupWorkspace } = await vite.ssrLoadModule('/src/presentation/components/ModelsSetupWorkspace.jsx');

    const offlineReport = {
      overall: {
        status: 'needs_download',
        label: 'Online Only — Downloads Required',
        description: 'Some model weights are not cached on local disk.',
        isOfflineReady: false,
      },
      offlineReadiness: evaluateOfflineReadiness({
        isOnline: false,
        models: {
          voxcpm: true,
          whisper: true,
          khmerAsr: false,
          translator: false,
          diarization: true,
          burnIn: true,
          audioMastering: true,
        },
      }),
      services: [
        { id: 'engine', name: 'VoxCPM2 Engine', port: 8808, status: 'online', details: 'active' },
        { id: 'media', name: 'Media Subtitle Service', port: 8810, status: 'online', details: 'active' },
        { id: 'storage', name: 'Storage & Audio Mastering API', port: 8090, status: 'online', details: 'active' },
      ],
      models: [
        { id: 'voxcpm', name: 'VoxCPM2 Core Speech Model', repo: 'openbmb/VoxCPM2', state: 'ready', description: 'ready' },
      ],
      storage: { volumeFreeFormatted: '50.0 GB', volumeTotalFormatted: '500.0 GB', headroomState: 'healthy' },
      instructions: [],
    };

    const html = renderToStaticMarkup(
      React.createElement(ModelsSetupWorkspace, {
        hidden: false,
        initialDiagnostics: offlineReport,
      })
    );

    // Hero banner displays Offline (Cached Features Available)
    assert.ok(html.includes('Offline (Cached Features Available)'));
    assert.ok(html.includes('readiness-offline-cached'));

    // Feature Offline Readiness Breakdown panel
    assert.ok(html.includes('Feature Offline Readiness'));
    assert.ok(html.includes('Text-to-Speech (VoxCPM2)'));
    assert.ok(html.includes('Video Transcription (Whisper)'));
    assert.ok(html.includes('Subtitle Translation (NLLB-200)'));
    assert.ok(html.includes('Speaker Diarization (Sherpa-ONNX)'));
    assert.ok(html.includes('Subtitle Video Burn-In (FFmpeg libass)'));
    assert.ok(html.includes('Project Storage &amp; Audio Mastering'));

    // Download specs and requirements are displayed
    assert.ok(html.includes('facebook/nllb-200-distilled-600M'));
    assert.ok(html.includes('Download required (~2.4 GB)'));
    assert.ok(html.includes('seanghay/Qwen3-ASR-0.6B-Khmer'));
    assert.ok(html.includes('Download required (~1.2 GB)'));
  });
});

test('Toolbar and SubtitleToolbar render OfflineReadinessBadge alongside autosave badge', async () => {
  await withViteSsr(async vite => {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { Toolbar } = await vite.ssrLoadModule('/src/presentation/components/Toolbar.jsx');
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');

    const readiness = {
      status: OFFLINE_STATUS.OFFLINE_READY,
      label: 'Offline Ready',
      isOfflineReady: true,
    };

    const ttsToolbarHtml = renderToStaticMarkup(
      React.createElement(Toolbar, {
        busy: false,
        generateDisabled: false,
        shortcut: '⌘ Enter',
        onCancel() {},
        autosave: { status: 'saved', lastSavedAt: '12:00' },
        offlineReadiness: readiness,
      })
    );
    assert.ok(ttsToolbarHtml.includes('id="project-autosave-status"'));
    assert.ok(ttsToolbarHtml.includes('id="offline-readiness-badge"'));
    assert.ok(ttsToolbarHtml.includes('Offline Ready'));

    const stubServices = {
      logger: { debug() {}, warn() {}, error() {} },
      mediaSubtitleGateway: { checkHealth: async () => ({ online: true, models: {} }) },
    };

    const subtitleHtml = renderToStaticMarkup(
      React.createElement(
        StudioProvider,
        { services: stubServices },
        React.createElement(VideoSubtitleWorkspace, {
          hidden: false,
          offlineReadiness: readiness,
        })
      )
    );
    assert.ok(subtitleHtml.includes('id="offline-readiness-badge"'));
    assert.ok(subtitleHtml.includes('Offline Ready'));
  });
});

test('Domain synthesizeSpeech use case blocks preflight with OfflineModelMissingError when offline and uncached', async () => {
  await withViteSsr(async vite => {
    const { createSynthesizeSpeechUseCase } = await vite.ssrLoadModule('/src/domain/useCases.js');
    const { OfflineModelMissingError } = await vite.ssrLoadModule('/src/domain/offlineReadiness.js');

    let gatewayCalled = false;
    const speechGateway = {
      uploadReferenceAudio: async () => ({ path: '/tmp/ref.wav' }),
      synthesize: async () => {
        gatewayCalled = true;
        return { blob: new Blob(['RIFF....WAVE']), seed: 42 };
      },
    };

    const useCase = createSynthesizeSpeechUseCase({
      speechGateway,
      seedGenerator: () => 12345,
    });

    // Offline and model uncached -> throws OfflineModelMissingError immediately
    await assert.rejects(
      async () => {
        await useCase.execute({
          script: 'Hello world',
          character: { id: 'char-1', name: 'Sophea' },
          models: { voxcpm: false },
          isOnline: false,
        });
      },
      err => {
        assert.ok(err instanceof OfflineModelMissingError);
        assert.equal(err.featureId, 'tts');
        assert.match(err.message, /VoxCPM2/);
        assert.match(err.message, /4\.8 GB/);
        return true;
      }
    );

    assert.equal(gatewayCalled, false, 'Speech gateway should never be called when preflight offline check fails');

    // Offline but model cached -> executes successfully
    const result = await useCase.execute({
      script: 'Hello world',
      character: { id: 'char-1', name: 'Sophea', description: 'Female calm voice' },
      guidance: 2,
      steps: 10,
      seed: 12345,
      models: { voxcpm: true },
      isOnline: false,
    });
    assert.ok(result?.recording);
    assert.equal(gatewayCalled, true, 'Speech gateway executes when model is cached offline');

    // regenerateChunk pre-flight blocks with OfflineModelMissingError when offline and uncached
    let regenerateGatewayCalled = false;
    const regenGateway = {
      uploadReferenceAudio: async () => ({ path: '/tmp/ref.wav' }),
      synthesize: async () => {
        regenerateGatewayCalled = true;
        return { blob: new Blob(['RIFF....WAVE']), seed: 99 };
      },
    };
    const regenUseCase = createSynthesizeSpeechUseCase({
      speechGateway: regenGateway,
      seedGenerator: () => 54321,
    });

    await assert.rejects(
      async () => {
        await regenUseCase.regenerateChunk({
          recording: result.recording,
          index: 0,
          text: 'Regenerated line',
          character: { id: 'char-1', name: 'Sophea' },
          options: {},
          models: { voxcpm: false },
          isOnline: false,
        });
      },
      err => {
        assert.ok(err instanceof OfflineModelMissingError);
        assert.equal(err.featureId, 'tts');
        return true;
      }
    );
    assert.equal(regenerateGatewayCalled, false, 'Speech gateway should never be called when regenerateChunk preflight fails');
  });
});
