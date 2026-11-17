/**
 * @fileoverview Vite dev/build configuration with live reload and Gradio API proxying.
 */

import { defineConfig } from 'vite';

const GRADIO_TARGET = process.env.GRADIO_URL || 'http://host.docker.internal:8808';
const STORAGE_TARGET = process.env.STORAGE_URL || 'http://127.0.0.1:8090';
const DEV_PORT = 5173;
const PROXY_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 250;
const ALLOWED_GRADIO_PATH = /^\/gradio_api\/(info|upload|call\/generate(\/[a-f0-9]+)?|file=\/.+\.wav)$/;
const ALLOWED_STORAGE_PATH = /^\/api\/v1\/(health|characters(\/[^/]+)?|anchors(\/[^/]+(\/audio)?)?)$/;

/**
 * Attaches proxy error handling returning HTTP 502 JSON when an upstream service is unreachable.
 * Inputs: Vite `HttpProxy.Server` instance and fallback error message.
 * Outputs: none.
 * Side effects: registers an `'error'` listener on the proxy server.
 * Failure modes: skips response writing if headers were already sent.
 * @param {import('vite').HttpProxy.Server} proxy - Proxy server instance.
 * @param {string} fallbackMessage - Upstream error message.
 */
function configureProxyError(proxy, fallbackMessage) {
  proxy.on('error', (error, _req, res) => {
    if (!res || res.headersSent || typeof res.writeHead !== 'function') return;
    const message = error?.message || fallbackMessage;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: message, data: null, error: { code: 'UPSTREAM_UNREACHABLE', message } }));
  });
}

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: DEV_PORT,
    strictPort: true,
    watch: {
      usePolling: process.env.VITE_USE_POLLING !== 'false',
      interval: POLL_INTERVAL_MS,
    },
    proxy: {
      '/gradio_api': {
        target: GRADIO_TARGET,
        changeOrigin: false,
        timeout: PROXY_TIMEOUT_MS,
        proxyTimeout: PROXY_TIMEOUT_MS,
        configure: proxy => configureProxyError(proxy, 'VoxCPM2 upstream unreachable.'),
        bypass(req) {
          const urlPath = (req.url || '').split('?')[0];
          if (!ALLOWED_GRADIO_PATH.test(urlPath)) return false;
        },
      },
      '/api/v1': {
        target: STORAGE_TARGET,
        changeOrigin: false,
        timeout: 60000,
        proxyTimeout: 60000,
        configure: proxy => configureProxyError(proxy, 'Voice Studio storage service unreachable.'),
        bypass(req) {
          const urlPath = (req.url || '').split('?')[0];
          if (!ALLOWED_STORAGE_PATH.test(urlPath)) return false;
        },
      },
    },
  },
});
