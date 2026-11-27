import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticsGateway } from '../../src/data/diagnosticsGateway.js';
import { MODEL_STATE, OVERALL_READINESS, SERVICE_STATUS } from '../../src/domain/modelDiagnostics.js';

test('createDiagnosticsGateway aggregates healthy responses from all local services', async () => {
  const speechGateway = {
    checkHealth: async () => ({ available: true, device: 'Apple Silicon (MPS)', reason: null }),
  };
  const mediaSubtitleGateway = {
    checkHealth: async () => ({
      online: true,
      models: { whisper: true, khmerAsr: true, translator: true, diarization: true },
      burnInSupported: true,
      pid: 1234,
    }),
  };
  const fetchImpl = async url => {
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({ data: { status: 'ok', ffmpegAvailable: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/stats')) {
      return new Response(JSON.stringify({ data: { storage: { volumeFreeBytes: 50 * 1024 * 1024 * 1024 } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  };

  const gateway = createDiagnosticsGateway({ speechGateway, mediaSubtitleGateway, fetchImpl });
  const result = await gateway.getAggregatedDiagnostics();

  assert.equal(result.overall.status, OVERALL_READINESS.OFFLINE_READY);
  assert.equal(result.overall.isOfflineReady, true);
  assert.equal(result.services.every(s => s.status === SERVICE_STATUS.ONLINE), true);
  assert.equal(result.models.every(m => m.state === MODEL_STATE.READY), true);
  assert.equal(result.instructions.length, 0);
});

test('createDiagnosticsGateway gracefully handles service errors without throwing', async () => {
  const logs = [];
  const logger = {
    debug: (scope, msg, meta) => logs.push({ scope, msg, meta }),
  };
  const speechGateway = {
    checkHealth: async () => {
      throw new Error('Engine connection refused');
    },
  };
  const mediaSubtitleGateway = {
    checkHealth: async () => ({ online: false, reason: 'Media service 502' }),
  };
  const fetchImpl = async () => {
    throw new Error('Network error');
  };

  const gateway = createDiagnosticsGateway({ speechGateway, mediaSubtitleGateway, fetchImpl, logger });
  const result = await gateway.getAggregatedDiagnostics();

  assert.equal(result.overall.status, OVERALL_READINESS.SERVICES_OFFLINE);
  assert.equal(result.overall.isOfflineReady, false);
  assert.equal(result.services.every(s => s.status === SERVICE_STATUS.OFFLINE), true);
  assert.ok(result.instructions.length >= 3);
  assert.ok(logs.length > 0);
});

test('createDiagnosticsGateway handles storage timeout with user-friendly reason', async () => {
  const speechGateway = {
    checkAvailability: async () => true,
  };
  const mediaSubtitleGateway = {
    checkHealth: async () => ({ online: true }),
  };
  const fetchImpl = async () => {
    const err = new Error('Timeout');
    err.name = 'TimeoutError';
    throw err;
  };

  const gateway = createDiagnosticsGateway({ speechGateway, mediaSubtitleGateway, fetchImpl });
  const result = await gateway.getAggregatedDiagnostics();

  const storageService = result.services.find(s => s.id === 'storage');
  assert.equal(storageService.status, SERVICE_STATUS.OFFLINE);
  assert.match(storageService.details, /3s/);
});

test('createDiagnosticsGateway reports NEEDS_DOWNLOAD when services are up but models missing', async () => {
  const speechGateway = {
    checkHealth: async () => ({ available: true, reason: null }),
  };
  const mediaSubtitleGateway = {
    checkHealth: async () => ({
      online: true,
      models: { whisper: false, khmerAsr: false, translator: true, diarization: true },
      burnInSupported: true,
    }),
  };
  const fetchImpl = async url => {
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({ data: { status: 'ok', ffmpegAvailable: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ data: { storage: {} } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const gateway = createDiagnosticsGateway({ speechGateway, mediaSubtitleGateway, fetchImpl });
  const result = await gateway.getAggregatedDiagnostics();

  assert.equal(result.overall.status, OVERALL_READINESS.NEEDS_DOWNLOAD);
  assert.equal(result.overall.isOfflineReady, false);
  const whisper = result.models.find(m => m.id === 'whisper');
  assert.equal(whisper.state, MODEL_STATE.NOT_INSTALLED);
  assert.ok(result.instructions.some(i => i.includes('Whisper Large v3 Turbo')));
});
