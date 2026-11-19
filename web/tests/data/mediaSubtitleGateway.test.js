import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaSubtitleGateway } from '../../src/data/mediaSubtitleGateway.js';
import { SynthesisCancelledError, SynthesisError } from '../../src/domain/errors.js';

test('mediaSubtitleGateway checks health, transcribes video, translates, and burns MP4 cleanly', async () => {
  const calls = [];
  const gateway = createMediaSubtitleGateway({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === '/media_api/health') return new Response(JSON.stringify({ burnInSupported: true, diarizationReady: true }), { status: 200 });
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
  assert.deepEqual(health, { online: true, burnInSupported: true, diarizationReady: true });

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
