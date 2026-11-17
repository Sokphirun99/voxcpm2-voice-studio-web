import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGradioSpeechGateway,
  extractCompleteResult,
  extractErrorDetail,
  parseSseEvents,
  translateServerError,
} from '../../src/data/gradioSpeechGateway.js';
import { SynthesisCancelledError, SynthesisError } from '../../src/domain/errors.js';

test('parseSseEvents handles CRLF, heartbeats, and complete frames', () => {
  const raw = 'event: heartbeat\r\ndata: null\r\n\r\nevent: complete\r\ndata: [{"url":"/gradio_api/file=/tmp/gradio/abc/audio.wav"}, 42]\r\n\r\n';
  const events = parseSseEvents(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'heartbeat');
  assert.equal(events[1].event, 'complete');
  const result = extractCompleteResult(events[1].data, 'http://127.0.0.1:8087');
  assert.deepEqual(result, { filePath: '/gradio_api/file=/tmp/gradio/abc/audio.wav', seed: 42 });
});

test('extractErrorDetail and translateServerError surface real error causes without stack traces', () => {
  assert.equal(extractErrorDetail('null'), '');
  assert.equal(extractErrorDetail('"Server stopped unexpectedly."'), 'Server stopped unexpectedly.');
  assert.equal(extractErrorDetail('{"error":"CUDA out of memory"}'), 'CUDA out of memory');

  assert.match(translateServerError('Queue is full. Max size is 10.', 503), /queue is full/i);
  assert.match(translateServerError('MPS backend out of memory'), /ran out of GPU or system memory/i);
  assert.match(translateServerError('HfHubHTTPError: 401 Client Error for weights'), /model weights/i);
  assert.match(translateServerError('InvalidPathError: not uploaded by a user'), /expired on the server/i);
  const stripped = translateServerError('Traceback (most recent call last):\nFile "/Users/dev/app.py", line 10\nValueError: bad pitch');
  assert.ok(!stripped.includes('Traceback'));
  assert.ok(!stripped.includes('/Users/dev'));
  assert.ok(!translateServerError('').includes('shorter passage'));
});

test('synthesize executes POST -> SSE -> WAV download and passes 10 Gradio args', async () => {
  const calls = [];
  const gateway = createGradioSpeechGateway({
    origin: 'http://127.0.0.1:8087',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === '/gradio_api/call/generate') {
        const body = JSON.parse(init.body);
        assert.equal(body.data.length, 10);
        assert.equal(body.data[0], 'Hello');
        assert.equal(body.data[1], 'Warm voice');
        return new Response(JSON.stringify({ event_id: 'abcdef01' }), { status: 200 });
      }
      if (url === '/gradio_api/call/generate/abcdef01') {
        return new Response('event: complete\ndata: [{"url":"/gradio_api/file=/tmp/gradio/11/audio.wav"}, 77]\n\n', { status: 200 });
      }
      if (url === '/gradio_api/file=/tmp/gradio/11/audio.wav') {
        return new Response(new Blob(['RIFF']), { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const res = await gateway.synthesize({ text: 'Hello', instruction: 'Warm voice', guidance: 2, seed: 77 });
  assert.equal(res.seed, 77);
  assert.equal(res.blob.type, 'audio/wav');
  assert.equal(await res.blob.text(), 'RIFF');
  assert.equal(calls.length, 3);
});

test('synthesize normalizes application/octet-stream WAV responses to audio/wav', async () => {
  const gateway = createGradioSpeechGateway({
    origin: 'http://127.0.0.1:8087',
    fetchImpl: async url => {
      if (url === '/gradio_api/call/generate') return new Response(JSON.stringify({ event_id: 'ab01' }), { status: 200 });
      if (url === '/gradio_api/call/generate/ab01') {
        return new Response('event: complete\ndata: [{"url":"/gradio_api/file=/tmp/gradio/11/audio.wav"}, 12]\n\n', { status: 200 });
      }
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    },
  });

  const res = await gateway.synthesize({ text: 'Test', instruction: '', guidance: 2, seed: 12 });
  assert.equal(res.blob.type, 'audio/wav');
});

test('synthesize translates queue-full 503 and SSE error events accurately', async () => {
  const queueGateway = createGradioSpeechGateway({
    origin: 'http://127.0.0.1:8087',
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'Queue is full. Max size is 10 and size is 10.' }), { status: 503 }),
  });

  await assert.rejects(
    () => queueGateway.synthesize({ text: 'Hi', instruction: '', guidance: 2, seed: 1 }),
    err => err instanceof SynthesisError && err.status === 503 && /queue is full/i.test(err.message)
  );

  const sseErrorGateway = createGradioSpeechGateway({
    origin: 'http://127.0.0.1:8087',
    fetchImpl: async url => {
      if (url === '/gradio_api/call/generate') return new Response(JSON.stringify({ event_id: 'ab12' }), { status: 200 });
      return new Response('event: error\ndata: "CUDA out of memory"\n\n', { status: 200 });
    },
  });

  await assert.rejects(
    () => sseErrorGateway.synthesize({ text: 'Hi', instruction: '', guidance: 2, seed: 1 }),
    err => err instanceof SynthesisError && /memory/i.test(err.message)
  );
});

test('synthesize rejects untrusted file URLs and supports AbortController cancellation', async () => {
  const unsafeGateway = createGradioSpeechGateway({
    origin: 'http://127.0.0.1:8087',
    fetchImpl: async url => {
      if (url === '/gradio_api/call/generate') return new Response(JSON.stringify({ event_id: 'ab12' }), { status: 200 });
      return new Response('event: complete\ndata: [{"url":"https://evil.example/a.wav"}, 1]\n\n', { status: 200 });
    },
  });

  await assert.rejects(
    () => unsafeGateway.synthesize({ text: 'Hi', instruction: '', guidance: 2, seed: 1 }),
    err => err instanceof SynthesisError && err.code === 'UNSAFE_FILE_URL'
  );
  assert.throws(
    () => extractCompleteResult('[{"url":"/gradio_api/file=/tmp/../etc/passwd.wav"}, 1]', 'http://127.0.0.1:8087'),
    err => err instanceof SynthesisError && err.code === 'UNSAFE_FILE_URL'
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => unsafeGateway.synthesize({ text: 'Hi', instruction: '', guidance: 2, seed: 1, signal: controller.signal }),
    SynthesisCancelledError
  );
});

test('synthesize handles chunked SSE JSON split across multiple stream reads', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: heartbeat\ndata: null\n\nevent: complete\ndata: [{"url":"/gradio_api'));
      controller.enqueue(encoder.encode('/file=/tmp/gradio/99/audio.wav"}, 99]\n\n'));
      controller.close();
    },
  });

  const gateway = createGradioSpeechGateway({
    origin: 'http://127.0.0.1:8087',
    fetchImpl: async url => {
      if (url === '/gradio_api/call/generate') return new Response(JSON.stringify({ event_id: 'ab99' }), { status: 200 });
      if (url === '/gradio_api/call/generate/ab99') return new Response(stream, { status: 200 });
      return new Response(new Blob(['WAVE']), { status: 200 });
    },
  });

  const res = await gateway.synthesize({ text: 'Chunked', instruction: '', guidance: 2, seed: 99 });
  assert.equal(res.seed, 99);
  assert.equal(await res.blob.text(), 'WAVE');
});

test('checkAvailability returns true only when /generate endpoint is registered', async () => {
  const onlineGateway = createGradioSpeechGateway({
    fetchImpl: async () => new Response(JSON.stringify({ named_endpoints: { '/generate': {} } }), { status: 200 }),
  });
  const offlineGateway = createGradioSpeechGateway({
    fetchImpl: async () => new Response('down', { status: 502 }),
  });

  assert.equal(await onlineGateway.checkAvailability(), true);
  assert.equal(await offlineGateway.checkAvailability(), false);
});

test('checkHealth surfaces specific offline reasons on proxy, endpoint, timeout, and network failures', async () => {
  const ready = await createGradioSpeechGateway({
    fetchImpl: async () => new Response(JSON.stringify({ named_endpoints: { '/generate': {} } }), { status: 200 }),
  }).checkHealth();
  assert.deepEqual(ready, { available: true, reason: null });

  const badGateway = await createGradioSpeechGateway({
    fetchImpl: async () => new Response('Bad Gateway', { status: 502 }),
  }).checkHealth();
  assert.equal(badGateway.available, false);
  assert.match(badGateway.reason, /502.*app\.py/i);

  const missingGenerate = await createGradioSpeechGateway({
    fetchImpl: async () => new Response(JSON.stringify({ named_endpoints: {} }), { status: 200 }),
  }).checkHealth();
  assert.equal(missingGenerate.available, false);
  assert.match(missingGenerate.reason, /\/generate/);

  const timedOut = await createGradioSpeechGateway({
    fetchImpl: async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    },
  }).checkHealth();
  assert.equal(timedOut.available, false);
  assert.match(timedOut.reason, /did not respond within 4s/i);

  const netErr = await createGradioSpeechGateway({
    fetchImpl: async () => {
      throw new Error('Failed to fetch');
    },
  }).checkHealth();
  assert.equal(netErr.available, false);
  assert.match(netErr.reason, /Failed to fetch/);
});

test('uploadReferenceAudio posts multipart files and returns Gradio FileData', async () => {
  const gateway = createGradioSpeechGateway({
    fetchImpl: async (url, init) => {
      assert.equal(url, '/gradio_api/upload');
      assert.equal(init.method, 'POST');
      assert.ok(init.body instanceof FormData);
      return new Response(JSON.stringify(['/tmp/gradio/uploads/voice.wav']), { status: 200 });
    },
  });

  const fileData = await gateway.uploadReferenceAudio({
    blob: new Blob(['RIFF'], { type: 'audio/wav' }),
    fileName: 'voice.wav',
    mimeType: 'audio/wav',
  });
  assert.deepEqual(fileData, {
    path: '/tmp/gradio/uploads/voice.wav',
    orig_name: 'voice.wav',
    mime_type: 'audio/wav',
    meta: { _type: 'gradio.FileData' },
  });
});

test('synthesize forwards locked reference FileData, steps, and Exact clone transcript', async () => {
  const ref = { path: '/tmp/gradio/uploads/take1.wav', orig_name: 'take1.wav', mime_type: 'audio/wav', meta: { _type: 'gradio.FileData' } };
  const gateway = createGradioSpeechGateway({
    origin: 'http://127.0.0.1:8087',
    fetchImpl: async (url, init) => {
      if (url === '/gradio_api/call/generate') {
        const body = JSON.parse(init.body);
        assert.deepEqual(body.data[2], ref);
        assert.equal(body.data[3], true);
        assert.equal(body.data[4], 'Hello first voice');
        assert.equal(body.data[8], 6);
        return new Response(JSON.stringify({ event_id: 'ef56' }), { status: 200 });
      }
      if (url === '/gradio_api/call/generate/ef56') {
        return new Response('event: complete\ndata: [{"url":"/gradio_api/file=/tmp/gradio/56/audio.wav"}, 456]\n\n', { status: 200 });
      }
      return new Response(new Blob(['WAV']), { status: 200 });
    },
  });

  const res = await gateway.synthesize({
    text: 'Second sentence',
    instruction: '',
    referenceFile: ref,
    usePromptText: true,
    promptText: 'Hello first voice',
    guidance: 2,
    steps: 6,
    seed: 456,
    denoiseReference: true,
  });
  assert.equal(res.seed, 456);
});

test('synthesize forwards DoDenoisePromptAudio flag at index 7', async () => {
  let payloadData = null;
  const gateway = createGradioSpeechGateway({
    origin: 'http://127.0.0.1:8087',
    fetchImpl: async (url, init) => {
      if (url === '/gradio_api/call/generate') {
        payloadData = JSON.parse(init.body).data;
        return new Response(JSON.stringify({ event_id: 'ab99' }), { status: 200 });
      }
      if (url === '/gradio_api/call/generate/ab99') {
        return new Response('event: complete\ndata: [{"url":"/gradio_api/file=/tmp/gradio/99/audio.wav"}, 1]\n\n', { status: 200 });
      }
      return new Response(new Blob(['WAV']), { status: 200 });
    },
  });
  await gateway.synthesize({ text: 'Hi', instruction: 'Warm', guidance: 2, steps: 10, seed: 1, denoiseReference: true });
  assert.equal(payloadData[7], true);
});
