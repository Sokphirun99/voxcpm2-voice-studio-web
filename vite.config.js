/**
 * @fileoverview Vite dev/build configuration with live reload and Gradio API proxying.
 */

import { defineConfig } from 'vite';

const GRADIO_TARGET = process.env.GRADIO_URL || 'http://host.docker.internal:8808';
const STORAGE_TARGET = process.env.STORAGE_URL || 'http://127.0.0.1:8090';
const MEDIA_TARGET = process.env.MEDIA_URL || 'http://127.0.0.1:8810';
const DEV_PORT = 5173;
const PROXY_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 250;
const BUILD_ID = process.env.APP_BUILD_ID || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ALLOWED_GRADIO_PATH = /^\/gradio_api\/(info|upload|call\/generate(\/[a-f0-9]+)?|file=\/.+\.wav)$/;
const ALLOWED_STORAGE_PATH = /^\/api\/v1\/(health|stats|characters(\/[^/]+)?|anchors(\/[^/]+(\/audio)?)?|audio\/master|cache\/[a-f0-9]{64}(\/audio)?)$/;
const ALLOWED_MEDIA_PATH = /^\/media_api\/(health|transcribe|translate|burn)$/;

/**
 * Emits `/version.json` in dev middleware and production bundles so clients detect fresh builds safely.
 * @param {string} buildId - Unique identifier for the current Vite build/dev instance.
 * @returns {import('vite').Plugin} Vite plugin descriptor.
 */
function versionManifestPlugin(buildId) {
  const payload = JSON.stringify({ buildId });
  return {
    name: 'voice-studio-version-manifest',
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(payload);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: payload });
    },
  };
}

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
  define: {
    __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [versionManifestPlugin(BUILD_ID)],
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
      '/media_api': {
        target: MEDIA_TARGET,
        changeOrigin: false,
        timeout: PROXY_TIMEOUT_MS,
        proxyTimeout: PROXY_TIMEOUT_MS,
        rewrite: path => path.replace(/^\/media_api/, ''),
        configure: proxy => configureProxyError(proxy, 'Local video subtitle service unreachable.'),
        bypass(req) {
          const urlPath = (req.url || '').split('?')[0];
          if (!ALLOWED_MEDIA_PATH.test(urlPath)) return false;
        },
      },
    },
  },
});
