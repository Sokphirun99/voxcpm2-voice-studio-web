/**
 * @fileoverview Domain port interfaces (abstractions) implemented by the data layer and injected via main.jsx.
 */

/**
 * @typedef {object} LoggerPort
 * @property {(location: string, message: string, context?: Record<string, unknown>) => void} debug
 * @property {(location: string, error: unknown, context?: Record<string, unknown>) => void} error
 */

/**
 * @typedef {object} SpeechGatewayPort
 * @property {() => Promise<boolean>} checkAvailability
 * @property {() => Promise<{ available: boolean, reason: string|null }>} [checkHealth]
 * @property {(params: { blob: Blob, fileName: string, mimeType?: string, signal?: AbortSignal }) => Promise<object>} uploadReferenceAudio
 * @property {(params: { text: string, instruction: string, referenceFile?: object|null, usePromptText?: boolean, promptText?: string, guidance: number, steps: number, seed: number, denoiseReference?: boolean, signal?: AbortSignal }) => Promise<{ blob: Blob, seed: number|null }>} synthesize
 */

/**
 * @typedef {object} VoiceRepositoryPort
 * @property {() => { entries: Array<object>, warning: string|null }} loadSavedEntries
 * @property {(entries: Array<object>) => void} saveEntries
 */

/**
 * @typedef {object} VoiceAnchorRepositoryPort
 * @property {() => Promise<Record<string, { characterId: string, label: string, blob: Blob, source: string, fileName: string, mimeType: string, promptText: string, exactClone: boolean, updatedAt: number }>>} loadAllAnchors
 * @property {(characterId: string, anchor: object) => Promise<void>} saveAnchor
 * @property {(characterId: string) => Promise<void>} deleteAnchor
 */

/**
 * @typedef {object} ProjectRepositoryPort
 * @property {(query?: { limit?: number, offset?: number, type?: string, kind?: string, status?: string, search?: string }) => Promise<{ items: Array<object>, total: number, limit: number, offset: number, hasMore: boolean }>} listProjects
 * @property {(id: string) => Promise<object|null>} getProject
 * @property {(project: object, options?: { expectedRevision?: number }) => Promise<{ project: object, isCreated: boolean }>} saveProject
 * @property {(id: string, options?: { expectedRevision?: number }) => Promise<{ deleted: boolean, id: string }>} deleteProject
 * @property {(project: object) => Promise<{ project: object, isCreated: boolean }>} [createProject]
 * @property {(id: string, options?: { title?: string, name?: string }) => Promise<{ project: object }>} [duplicateProject]
 * @property {(id: string, options?: { expectedRevision?: number }) => Promise<{ project: object, restored?: boolean }>} [restoreProject]
 */

/**
 * @typedef {object} AssetRepositoryPort
 * @property {(params: { bytes: Uint8Array|Blob, fileName: string, kind?: string, mimeType?: string, projectId?: string|null }) => Promise<{ asset: object }>} uploadAsset
 * @property {(id: string) => Promise<object|null>} getAssetMeta
 * @property {(id: string) => Promise<{ bytes: Uint8Array, mimeType: string, meta: object }|null>} getAssetBinary
 * @property {(id: string, options?: { hard?: boolean }) => Promise<{ deleted: boolean, id: string }>} deleteAsset
 * @property {(query?: { limit?: number, offset?: number, projectId?: string, kind?: string }) => Promise<{ items: Array<object>, total: number, limit: number, offset: number, hasMore: boolean }>} listAssets
 */

/**
 * @typedef {object} JobRepositoryPort
 * @property {(query?: { limit?: number, offset?: number, status?: string, type?: string, projectId?: string }) => Promise<{ items: Array<object>, total: number, limit: number, offset: number, hasMore: boolean, summary?: object }>} listJobs
 * @property {(id: string) => Promise<object|null>} getJob
 * @property {(spec: object) => Promise<{ job: object, evictedIds?: string[] }>} enqueueJob
 * @property {(id: string, patch: object, options?: { expectedRevision?: number }) => Promise<{ job: object }>} updateJob
 * @property {(id: string, options?: { finalize?: boolean, expectedRevision?: number }) => Promise<{ job: object }>} cancelJob
 * @property {(id: string, options?: { expectedRevision?: number }) => Promise<{ job: object }>} retryJob
 * @property {(id: string, options?: { reason?: string, expectedRevision?: number }) => Promise<{ job: object }>} interruptJob
 * @property {() => Promise<{ recoveredCount: number, jobs: Array<object> }>} recoverInterruptedJobs
 * @property {(id: string, options?: { expectedRevision?: number }) => Promise<{ deleted: boolean, id: string }>} deleteJob
 * @property {() => Promise<{ clearedCount: number }>} clearHistory
 */

/**
 * @typedef {object} GlossaryRepositoryPort
 * @property {() => Promise<Array<{ id: string, source: string, replacement: string, enabled: boolean }>>} loadRules
 * @property {(rules: Array<object>) => Promise<{ rules: Array<object>, localOnly: boolean }>} [saveRules]
 */

/**
 * @typedef {object} TerminologyRepositoryPort
 * @property {() => Promise<Array<object>>} loadTerms
 * @property {(terms: Array<object>) => Promise<{ terms: Array<object>, localOnly: boolean }>} [saveTerms]
 */

/**
 * @typedef {object} AudioDecoderPort
 * @property {(blob: Blob) => Promise<number[]>} decodePeaks
 * @property {(blob: Blob) => Promise<{ peaks: number[], duration: number }>} [decodeAudioSummary]
 */

/**
 * @typedef {object} AudioMasterPort
 * @property {(blob: Blob, options?: { signal?: AbortSignal }) => Promise<{ blob: Blob, mastered: boolean }>} masterWav
 */

/**
 * @typedef {object} SynthesisCachePort
 * @property {(spec: object) => Promise<string>} computeKey
 * @property {(key: string, options?: { signal?: AbortSignal }) => Promise<{ blob: Blob, seed: number|null }|null>} getCachedAudio
 * @property {(key: string, blob: Blob, meta?: object) => Promise<void>} putCachedAudio
 */

/**
 * Validates that a required dependency port exposes every expected method.
 * Inputs: port object, port name, required method names.
 * Outputs: validated port reference.
 * Side effects: none.
 * Failure modes: throws TypeError if port is missing any required method.
 * @template T
 * @param {T} port - Injected adapter instance.
 * @param {string} name - Port label for diagnostics.
 * @param {string[]} methods - Required method names.
 * @returns {T} Verified port instance.
 */
export function assertPort(port, name, methods) {
  if (!port || typeof port !== 'object') {
    throw new TypeError(`Missing required port: ${name}`);
  }
  for (const method of methods) {
    if (typeof port[method] !== 'function') {
      throw new TypeError(`Port ${name} must implement ${method}()`);
    }
  }
  return port;
}
