/**
 * @fileoverview SSR and integration tests for Models & Setup Workspace (R1-07).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { MODEL_STATE, aggregateDiagnostics } from '../../src/domain/modelDiagnostics.js';

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

function createStubDiagnosticsGateway(report) {
  return {
    getAggregatedDiagnostics: async () => report,
  };
}

test('ModelsSetupWorkspace SSR renders toolbar, services, models, and storage sections', async () => {
  await withViteSsr(async vite => {
    const { ModelsSetupWorkspace } = await vite.ssrLoadModule('/src/presentation/components/ModelsSetupWorkspace.jsx');

    const report = aggregateDiagnostics({
      engineHealth: { available: true },
      mediaHealth: {
        online: true,
        models: { whisper: true, khmerAsr: true, translator: true, diarization: true },
        burnInSupported: true,
        pid: 1234,
      },
      storageHealth: { online: true, ffmpegAvailable: true },
      storageStats: {
        storage: {
          volumeFreeBytes: 100 * 1024 * 1024 * 1024,
          volumeTotalBytes: 500 * 1024 * 1024 * 1024,
          charactersCount: 10,
          anchorsCount: 4,
          cacheEntriesCount: 3,
        },
        container: {
          rssBytes: 120 * 1024 * 1024,
        },
      },
    });

    const html = renderToStaticMarkup(
      React.createElement(ModelsSetupWorkspace, {
        hidden: false,
        diagnosticsGateway: createStubDiagnosticsGateway(report),
        initialDiagnostics: report,
      })
    );

    // Toolbar
    assert.ok(html.includes('id="models-workspace-pane"'));
    assert.ok(html.includes('id="refresh-diagnostics-btn"'));
    assert.ok(html.includes('Models &amp; Setup'));

    // Hero banner
    assert.ok(html.includes('id="readiness-label"'));
    assert.ok(html.includes('Fully Ready for Offline Use'));
    assert.ok(html.includes('Offline Ready'));

    // Local Services
    assert.ok(html.includes('VoxCPM2 Engine'));
    assert.ok(html.includes('Media Subtitle Service'));
    assert.ok(html.includes('Storage &amp; Audio Mastering API'));
    assert.ok(html.includes('Port 8808'));
    assert.ok(html.includes('Port 8810'));
    assert.ok(html.includes('Port 8090'));

    // Models & Pipeline
    assert.ok(html.includes('VoxCPM2 Core Speech Model'));
    assert.ok(html.includes('Whisper Large v3 Turbo'));
    assert.ok(html.includes('Qwen3 Khmer ASR &amp; Verifier'));
    assert.ok(html.includes('NLLB-200 600M Translation'));
    assert.ok(html.includes('Sherpa-ONNX Diarization &amp; Denoiser'));
    assert.ok(html.includes('FFmpeg Subtitle Burn-In (libass)'));

    // Storage metrics
    assert.ok(html.includes('id="storage-volume-free"'));
    assert.ok(html.includes('100.0 GB'));
    assert.ok(html.includes('id="storage-characters-count"'));
    assert.ok(html.includes('10'));
    assert.ok(html.includes('id="storage-container-rss"'));
    assert.ok(html.includes('120.0 MB'));
  });
});

test('ModelsSetupWorkspace displays actionable instructions when models are not installed', async () => {
  await withViteSsr(async vite => {
    const { ModelsSetupWorkspace } = await vite.ssrLoadModule('/src/presentation/components/ModelsSetupWorkspace.jsx');

    const report = aggregateDiagnostics({
      engineHealth: { available: true },
      mediaHealth: {
        online: true,
        models: { whisper: false, khmerAsr: false, translator: true, diarization: true },
        burnInSupported: true,
      },
      storageHealth: { online: true, ffmpegAvailable: true },
      storageStats: { storage: { volumeFreeBytes: 50 * 1024 * 1024 * 1024 } },
    });

    const html = renderToStaticMarkup(
      React.createElement(ModelsSetupWorkspace, {
        hidden: false,
        diagnosticsGateway: createStubDiagnosticsGateway(report),
        initialDiagnostics: report,
      })
    );

    // Hero banner should indicate setup required, NOT offline ready
    assert.ok(html.includes('Online Only — Downloads Required'));
    assert.ok(html.includes('Setup Required'));
    assert.equal(html.includes('Fully Ready for Offline Use'), false);

    // Should render actionable instructions
    assert.ok(html.includes('Actionable Setup Steps'));
    assert.ok(html.includes('mlx-community/whisper-large-v3-turbo'));
    assert.ok(html.includes('seanghay/Qwen3-ASR-0.6B-Khmer'));

    // Model cards should show Not Installed pill
    assert.ok(html.includes('id="model-status-whisper"'));
    assert.ok(html.includes('Not Installed'));
  });
});

test('ModelsSetupWorkspace renders downloading and error status pills accurately', async () => {
  await withViteSsr(async vite => {
    const { ModelsSetupWorkspace } = await vite.ssrLoadModule('/src/presentation/components/ModelsSetupWorkspace.jsx');

    const report = aggregateDiagnostics({
      engineHealth: { available: true },
      mediaHealth: {
        online: true,
        models: {
          whisper: MODEL_STATE.DOWNLOADING,
          khmerAsr: { state: MODEL_STATE.ERROR, error: 'Tokenizer missing' },
          translator: true,
          diarization: true,
        },
        burnInSupported: true,
      },
      storageHealth: { online: true, ffmpegAvailable: true },
      storageStats: { storage: { volumeFreeBytes: 50 * 1024 * 1024 * 1024 } },
    });

    const html = renderToStaticMarkup(
      React.createElement(ModelsSetupWorkspace, {
        hidden: false,
        diagnosticsGateway: createStubDiagnosticsGateway(report),
        initialDiagnostics: report,
      })
    );

    assert.ok(html.includes('Downloading…'));
    assert.ok(html.includes('status-downloading'));
    assert.ok(html.includes('Error'));
    assert.ok(html.includes('status-error'));
    assert.ok(html.includes('Tokenizer missing'));
  });
});

test('ModelsSetupWorkspace displays service offline warnings when backend is unreachable', async () => {
  await withViteSsr(async vite => {
    const { ModelsSetupWorkspace } = await vite.ssrLoadModule('/src/presentation/components/ModelsSetupWorkspace.jsx');

    const report = aggregateDiagnostics({
      engineHealth: { available: false, reason: 'Port 8808 refused' },
      mediaHealth: { online: false, reason: 'Port 8810 unreachable' },
      storageHealth: { online: false, reason: 'Port 8090 down' },
    });

    const html = renderToStaticMarkup(
      React.createElement(ModelsSetupWorkspace, {
        hidden: false,
        diagnosticsGateway: createStubDiagnosticsGateway(report),
        initialDiagnostics: report,
      })
    );

    assert.ok(html.includes('Local Services Offline'));
    assert.ok(html.includes('./studio.sh start'));
    assert.ok(html.includes('Port 8808 refused'));
  });
});

test('Sidebar SSR renders nav-models alongside nav-projects, nav-tts, and nav-subtitles', async () => {
  await withViteSsr(async vite => {
    const { Sidebar } = await vite.ssrLoadModule('/src/presentation/components/Sidebar.jsx');
    const html = renderToStaticMarkup(
      React.createElement(Sidebar, { activeWorkspace: 'models', onSelectWorkspace() {} })
    );

    assert.ok(html.includes('id="nav-projects"'));
    assert.ok(html.includes('id="nav-tts"'));
    assert.ok(html.includes('id="nav-subtitles"'));
    assert.ok(html.includes('id="nav-models"'));
    assert.ok(html.includes('Models &amp; Setup'));
  });
});

test('Studio SSR renders ModelsSetupWorkspace when mounted', async () => {
  await withViteSsr(async vite => {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    const stubServices = {
      projectRepository: { listProjects: async () => ({ items: [] }), getProject: async () => null },
      speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: { execute: async () => ({}) },
      lockReferenceAudio: { execute: async file => ({ blob: file, fileName: file.name, mimeType: 'audio/wav' }) },
      voiceLibrary: { loadSaved: () => ({ entries: [], warning: null }), saveCustom: () => ({ entry: {}, entries: [] }), deleteCustom: () => [] },
      voiceAnchors: { loadAll: async () => ({}), pinCharacter: async p => p, updateAnchor: async () => null, unpinCharacter: async () => {} },
      diagnosticsGateway: createStubDiagnosticsGateway(aggregateDiagnostics()),
    };

    const html = renderToStaticMarkup(
      React.createElement(
        StudioProvider,
        { services: stubServices },
        React.createElement(Studio)
      )
    );

    assert.ok(html.includes('id="nav-models"'));
    assert.ok(html.includes('id="models-workspace-pane"'));
  });
});
