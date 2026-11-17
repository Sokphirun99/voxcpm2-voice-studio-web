/**
 * @fileoverview Vite dev/build configuration with live reload and Gradio API proxying.
 */

import { defineConfig } from 'vite';

const GRADIO_TARGET = process.env.GRADIO_URL || 'http://host.docker.internal:8808';
const DEV_PORT = 5173;
const PROXY_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 250;
const ALLOWED_GRADIO_PATH = /^\/gradio_api\/(info|upload|call\/generate(\/[a-f0-9]+)?|file=\/.+\.wav)$/;

/**
 * Attaches proxy error handling returning HTTP 502 JSON when Gradio is unreachable.
 * Inputs: Vite `HttpProxy.Server` instance.
 * Outputs: none.
 * Side effects: registers an `'error'` listener on the proxy server.
 * Failure modes: skips response writing if headers were already sent.
 * @param {import('vite').HttpProxy.Server} proxy - Proxy server instance.
 */
function configureGradioProxy(proxy) {
  proxy.on('error', (error, _req, res) => {
    if (!res || res.headersSent || typeof res.writeHead !== 'function') return;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: error?.message || 'VoxCPM2 upstream unreachable.' }));
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
        configure: configureGradioProxy,
        bypass(req) {
          const urlPath = (req.url || '').split('?')[0];
          if (!ALLOWED_GRADIO_PATH.test(urlPath)) return false;
        },
      },
    },
  },
});
