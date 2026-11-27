import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaSubtitleGateway } from '../../src/data/mediaSubtitleGateway.js';
import { SynthesisCancelledError, SynthesisError } from '../../src/domain/errors.js';

test('mediaSubtitleGateway checks health, transcribes video, translates, and burns MP4 cleanly', async () => {
  const calls = [];
  const gateway = createMediaSubtitleGateway({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === '/media_api/health') return new Response(JSON.stringify({ burnInSupported: true, diarizationReady: true, models: { whisper: true, khmerAsr: false, translator: true, diarization: false } }), { status: 200 });
      if (url === '/media_api/transcribe') return new Response(JSON.stringify({ jobId: 'abcd1234ef567890', language: 'en', segments: [] }), { status: 200 });
      if (url === '/media_api/translate') return new Response(JSON.stringify({ segments: [{ text: 'Hi', translatedText: 'សួស្តី' }] }), { status: 200 });
      if (url === '/media_api/burn') return new Response(new Blob(['MP4']), { status: 200, headers: { 'content-type': 'video/mp4' } });
      if (url === '/media_api/verify-speech') {
        return new Response(JSON.stringify({ verdict: 'pass', similarity: 0.96, heardText: 'សួស្តី', missingTerms: [] }), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const health = await gateway.checkHealth();
  assert.deepEqual(health, {
    online: true,
    burnInSupported: true,
    diarizationReady: true,
    models: { whisper: true, khmerAsr: false, translator: true, diarization: false },
  });

  const tr = await gateway.transcribeVideo({ file: new Blob(['vid'], { type: 'video/mp4' }), language: 'en', numSpeakers: 2, translateToKhmer: true });
  assert.equal(tr.jobId, 'abcd1234ef567890');
  assert.equal(calls[1].init.body.get('translate_to'), 'km');
  assert.equal(calls[1].init.body.get('double_check'), 'false');

  await gateway.transcribeVideo({ file: new Blob(['vid'], { type: 'video/mp4' }), language: 'km', numSpeakers: 1, translateTo: 'jpn_Jpan', doubleCheck: true });
  assert.equal(calls[2].init.body.get('language'), 'km');
  assert.equal(calls[2].init.body.get('translate_to'), 'jpn_Jpan');
  assert.equal(calls[2].init.body.get('double_check'), 'true');

  const translated = await gateway.translateSegments({ segments: [{ text: 'Hi' }], sourceLanguage: 'en', targetLanguage: 'km' });
  assert.equal(translated.segments[0].translatedText, 'សួស្តី');

  const mp4 = await gateway.burnSubtitles({ jobId: tr.jobId, segments: [], speakerNames: {} });
  assert.equal(await mp4.text(), 'MP4');

  const qa = await gateway.verifySpeech({ blob: new Blob(['RIFF'], { type: 'audio/wav' }), expectedText: 'សួស្តី', language: 'km' });
  assert.equal(qa.verdict, 'pass');
  assert.equal(qa.similarity, 0.96);
  assert.equal(calls.at(-1).init.body.get('expected_text'), 'សួស្តី');
  assert.equal(calls.at(-1).init.body.get('language'), 'km');
});

test('mediaSubtitleGateway defaults model readiness to cached when legacy health omits models', async () => {
  const gateway = createMediaSubtitleGateway({
    fetchImpl: async () => new Response(JSON.stringify({ burnInSupported: true }), { status: 200 }),
  });

  const health = await gateway.checkHealth();

  assert.deepEqual(health, {
    online: true,
    burnInSupported: true,
    diarizationReady: false,
    models: { whisper: true, khmerAsr: true, translator: true, diarization: true },
  });
});

test('mediaSubtitleGateway surfaces HTTP error details and cancellation cleanly', async () => {
  const errGw = createMediaSubtitleGateway({
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'Video session expired.' }), { status: 404 }),
  });
  await assert.rejects(
    () => errGw.burnSubtitles({ jobId: 'abcd1234ef567890', segments: [], speakerNames: {} }),
    err => err instanceof SynthesisError && /Video session expired/.test(err.message)
  );

  const abortGw = createMediaSubtitleGateway({
    fetchImpl: async () => { throw new DOMException('Aborted', 'AbortError'); },
  });
  await assert.rejects(() => abortGw.transcribeVideo({ file: new Blob(['v']) }), SynthesisCancelledError);

  const htmlStatuses = [
    { status: 502, html: '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>', match: /HTTP 502/ },
    { status: 504, html: '<!DOCTYPE html><html><head><title>504 Gateway Time-out</title></head></html>', match: /timed out.*HTTP 504/i },
    { status: 413, html: '<html><head><title>413 Request Entity Too Large</title></head></html>', match: /upload limit.*HTTP 413/i },
    { status: 500, html: '<div>Internal Error</div>', headers: { 'content-type': 'text/html' }, match: /HTTP 500/ },
  ];
  for (const item of htmlStatuses) {
    const htmlGw = createMediaSubtitleGateway({
      fetchImpl: async () => new Response(item.html, { status: item.status, headers: item.headers || { 'content-type': 'text/html' } }),
    });
    await assert.rejects(
      () => htmlGw.transcribeVideo({ file: new Blob(['v']) }),
      err => err instanceof SynthesisError && item.match.test(err.message) && !/[<>]/.test(err.message)
    );
  }
});

test('mediaSubtitleGateway exportDubbedVideo uploads multipart metadata + WAV clips and handles errors/cancellation', async () => {
  const calls = [];
  const gateway = createMediaSubtitleGateway({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(new Blob(['DUBBED_MP4'], { type: 'video/mp4' }), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    },
  });

  const wav1 = new Blob(['RIFF1111WAVE'], { type: 'audio/wav' });
  const wav2 = new Blob(['RIFF2222WAVE'], { type: 'audio/wav' });
  const mp4 = await gateway.exportDubbedVideo({
    jobId: 'abcd1234ef567890',
    originalAudioMode: 'mute',
    clips: [
      { segmentId: 'seg-1', start: 0.2, end: 1.5, blob: wav1 },
      { segmentId: 'seg-2', start: 2.0, end: 3.4, blob: wav2 },
    ],
  });

  assert.equal(await mp4.text(), 'DUBBED_MP4');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/media_api/dub');
  assert.equal(calls[0].init.method, 'POST');
  const form = calls[0].init.body;
  assert.equal(form.get('jobId'), 'abcd1234ef567890');
  assert.equal(form.get('originalAudioMode'), 'mute');
  assert.deepEqual(JSON.parse(form.get('metadata')), [
    { segmentId: 'seg-1', start: 0.2, end: 1.5, fileIndex: 0 },
    { segmentId: 'seg-2', start: 2.0, end: 3.4, fileIndex: 1 },
  ]);
  assert.equal(form.getAll('files').length, 2);

  await gateway.exportDubbedVideo({
    jobId: 'abcd1234ef567890',
    originalAudioMode: 'duck',
    clips: [{ segmentId: 'seg-1', start: 0.2, end: 1.0, blob: wav1, allowOverflow: true }],
  });
  assert.deepEqual(JSON.parse(calls[1].init.body.get('metadata')), [
    { segmentId: 'seg-1', start: 0.2, end: 1.0, fileIndex: 0, allowOverflow: true },
  ]);

  const errGw = createMediaSubtitleGateway({
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'Dubbed MP4 export is only supported for video files.' }), { status: 400 }),
  });
  await assert.rejects(
    () => errGw.exportDubbedVideo({ jobId: 'abcd1234ef567890', clips: [{ segmentId: 'seg-1', start: 0, end: 1, blob: wav1 }] }),
    err => err instanceof SynthesisError && /only supported for video files/i.test(err.message)
  );

  const abortGw = createMediaSubtitleGateway({
    fetchImpl: async () => { throw new DOMException('Aborted', 'AbortError'); },
  });
  await assert.rejects(
    () => abortGw.exportDubbedVideo({ jobId: 'abcd1234ef567890', clips: [{ segmentId: 'seg-1', start: 0, end: 1, blob: wav1 }] }),
    SynthesisCancelledError
  );
});

test('both Vite dev proxy and Nginx allowlist expose /media_api/dub while blocking unknown paths', async () => {
  const { readFile } = await import('node:fs/promises');
  const viteSource = await readFile(new URL('../../vite.config.js', import.meta.url), 'utf8');
  const viteLiteral = /const ALLOWED_MEDIA_PATH = (\/.+\/);/.exec(viteSource)?.[1];
  assert.ok(viteLiteral, 'ALLOWED_MEDIA_PATH not found in vite.config.js');
  const vitePattern = new RegExp(viteLiteral.slice(1, -1));
  for (const path of ['/media_api/health', '/media_api/transcribe', '/media_api/translate', '/media_api/burn', '/media_api/verify-speech', '/media_api/dub']) {
    assert.equal(vitePattern.test(path), true, `vite should allow ${path}`);
  }
  assert.equal(vitePattern.test('/media_api/admin'), false);

  const nginxSource = await readFile(new URL('../../nginx.conf', import.meta.url), 'utf8');
  const nginxMatch = /location ~ "(\^\/media_api\/[^"]+)"/.exec(nginxSource)?.[1];
  assert.ok(nginxMatch, 'media_api location regex not found in nginx.conf');
  const nginxPattern = new RegExp(nginxMatch);
  for (const path of ['/media_api/health', '/media_api/transcribe', '/media_api/translate', '/media_api/burn', '/media_api/verify-speech', '/media_api/dub']) {
    assert.equal(nginxPattern.test(path), true, `nginx should allow ${path}`);
  }
  assert.equal(nginxPattern.test('/media_api/admin'), false);
});

test('mediaSubtitleGateway forwards optional audioLanguage cleanly on burnSubtitles and exportDubbedVideo', async () => {
  const calls = [];
  const gateway = createMediaSubtitleGateway({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(new Blob(['MP4']), { status: 200, headers: { 'content-type': 'video/mp4' } });
    },
  });

  await gateway.burnSubtitles({
    jobId: 'abcd1234ef567890',
    segments: [{ id: 's1', start: 0, end: 1, text: 'សួស្តី' }],
    speakerNames: {},
    audioLanguage: 'khm_Khmr',
  });
  assert.equal(JSON.parse(calls[0].init.body).audioLanguage, 'khm_Khmr');

  await gateway.burnSubtitles({
    jobId: 'abcd1234ef567890',
    segments: [],
    speakerNames: {},
  });
  assert.equal('audioLanguage' in JSON.parse(calls[1].init.body), false);

  const wav = new Blob(['RIFF1111WAVE'], { type: 'audio/wav' });
  await gateway.exportDubbedVideo({
    jobId: 'abcd1234ef567890',
    originalAudioMode: 'duck',
    audioLanguage: 'eng_Latn',
    clips: [{ segmentId: 's1', start: 0, end: 1, blob: wav }],
  });
  assert.equal(calls[2].init.body.get('audioLanguage'), 'eng_Latn');

  await gateway.exportDubbedVideo({
    jobId: 'abcd1234ef567890',
    originalAudioMode: 'duck',
    clips: [{ segmentId: 's1', start: 0, end: 1, blob: wav }],
  });
  assert.equal(calls[3].init.body.get('audioLanguage'), null);

  // R3-09: custom mixSettings, subtitleMode/subtitles JSON, and 0-clip original audio mode
  await gateway.exportDubbedVideo({
    jobId: 'abcd1234ef567890',
    originalAudioMode: 'original',
    audioLanguage: 'en',
    mixSettings: { originalVolume: 0.85, dubVolume: 1, duckVolume: 0.15 },
    subtitleMode: 'soft',
    subtitles: { segments: [{ id: 's1', start: 0, end: 1, text: 'Hello' }], subtitleLanguage: 'en' },
    clips: [],
  });
  const origForm = calls[4].init.body;
  assert.equal(origForm.get('originalAudioMode'), 'original');
  assert.equal(origForm.get('originalVolume'), '0.85');
  assert.equal(origForm.get('dubVolume'), null);
  assert.equal(origForm.get('duckVolume'), null);
  assert.equal(origForm.get('subtitleMode'), 'soft');
  assert.equal(JSON.parse(origForm.get('subtitles')).subtitleLanguage, 'en');
  assert.deepEqual(JSON.parse(origForm.get('metadata')), []);
  assert.equal(origForm.getAll('files').length, 0);

  await gateway.exportDubbedVideo({
    jobId: 'abcd1234ef567890',
    originalAudioMode: 'duck',
    mixSettings: { originalVolume: 1, dubVolume: 1.3, duckVolume: 0.25 },
    subtitleMode: 'none',
    clips: [{ segmentId: 's1', start: 0, end: 1, blob: wav }],
  });
  const duckForm = calls[5].init.body;
  assert.equal(duckForm.get('originalVolume'), null);
  assert.equal(duckForm.get('dubVolume'), '1.3');
  assert.equal(duckForm.get('duckVolume'), '0.25');
  assert.equal(duckForm.get('subtitleMode'), null);
  assert.equal(duckForm.get('subtitles'), null);
});
