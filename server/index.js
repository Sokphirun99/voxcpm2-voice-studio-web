/**
 * @fileoverview HTTP entrypoint booting the persistent Voice Studio backend storage server.
 */

import http from 'node:http';
import { createStorageHttpApp } from './httpApp.js';
import { createServerLogger } from './logger.js';
import { createStorageStore } from './storageStore.js';

const DEFAULT_PORT = 8090;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_DATA_DIR = './data';

/**
 * Initializes persistent volume storage and starts the HTTP server with graceful signal shutdown.
 * Inputs: optional `{ port, host, dataDir }`.
 * Outputs: running Node `http.Server` instance.
 * Side effects: binds TCP port, creates `dataDir` on disk, attaches `SIGINT`/`SIGTERM` handlers.
 * Failure modes: logs fatal startup errors and exits non-zero if storage cannot initialize.
 * @param {{ port?: number, host?: string, dataDir?: string }} [config] - Runtime configuration.
 * @returns {Promise<import('node:http').Server>} Listening server.
 */
export async function startStorageServer({
  port = Number(process.env.PORT || DEFAULT_PORT),
  host = process.env.HOST || DEFAULT_HOST,
  dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR,
} = {}) {
  const logger = createServerLogger('startup');
  const store = createStorageStore({ dataDir });
  await store.init();

  const server = http.createServer(createStorageHttpApp({ store, logger }));
  await new Promise(resolve => server.listen(port, host, resolve));
  logger.info('Voice Studio storage service listening', { host, port, dataDir: store.dataDir });

  const shutdown = signal => {
    logger.info('Shutting down storage service', { signal });
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isEntrypoint) {
  startStorageServer().catch(error => {
    createServerLogger('startup').error('Failed to start storage service', { errorMessage: error?.message });
    process.exit(1);
  });
}
