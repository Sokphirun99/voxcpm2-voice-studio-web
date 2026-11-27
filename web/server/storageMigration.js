/**
 * @fileoverview Storage migration runner, automated pre-migration backup, and atomic rollback engine.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ALLOWED_AUDIO_MIME_TYPES, hasValidAudioMagicBytes } from '../src/domain/audioValidation.js';
import { StorageError, ValidationError } from '../src/domain/errors.js';
import { upgradeProjectSchema } from '../src/domain/projects.js';
import { normalizeGlossaryRules } from '../src/domain/pronunciationRules.js';
import { normalizeTerminologyList } from '../src/domain/terminology.js';
import { normalizeProductionJob } from '../src/domain/productionJobs.js';
import { normalizeSavedEntry } from '../src/domain/voiceLibrary.js';

export const STORAGE_BACKUP_DIR = '.backup';
export const CURRENT_CATALOG_VERSION = 1;
export const CURRENT_GLOSSARY_VERSION = 1;
export const CURRENT_PROJECT_SCHEMA_VERSION = 1;
export const DEFAULT_AUDIO_MIME = 'audio/wav';
export const OCTET_STREAM_MIME = 'application/octet-stream';
export const CATALOG_FILE_NAME = 'catalog.json';
export const GLOSSARY_FILE_NAME = 'glossary.json';
export const TERMINOLOGY_FILE_NAME = 'terminology.json';
export const PROJECTS_DIR_NAME = 'projects';
export const JOBS_DIR_NAME = 'jobs';
export const ANCHORS_DIR_NAME = 'anchors';
export const MANIFEST_FILE_NAME = 'manifest.json';
export const JSON_FILE_EXT = '.json';
export const DEFAULT_CATEGORY = 'character';
export const DEFAULT_ROLE = 'Custom character';
export const DEFAULT_TRAITS = '1 person · Saved character';
export const SINGLE_VOICE_SCOPE = 'single';
export const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const VALID_CATEGORIES = Object.freeze(new Set(['female', 'male', 'character']));

async function writeAtomicFile(targetPath, contents) {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, contents);
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(cleanupError => {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}

function computeBufferSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function checkPathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new StorageError(`Failed to check file existence: ${filePath}`, error);
  }
}

function resolveSafeRelPath(baseDir, candidateRelPath) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, candidateRelPath);
  if (!resolved.startsWith(`${base}${path.sep}`) && resolved !== base) {
    throw new StorageError(`Path escaped directory boundary: ${candidateRelPath}`);
  }
  return resolved;
}

async function safeReadJson(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new StorageError(`Failed to read JSON from ${filePath}`, error);
  }
}

async function copyBackupEntry(sourcePath, targetPath, relPath) {
  const bytes = await readFile(sourcePath);
  const sha256 = computeBufferSha256(bytes);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeAtomicFile(targetPath, bytes);
  return { relPath, sizeBytes: bytes.byteLength, sha256 };
}

function isProjectUuidFileName(fileName) {
  if (!fileName.endsWith(JSON_FILE_EXT)) return false;
  const id = fileName.slice(0, -JSON_FILE_EXT.length);
  return PROJECT_ID_PATTERN.test(id);
}

async function collectDirectoryJsonBackupFiles(sourceDir, backupSubDir, relDirName) {
  try {
    const entries = await readdir(sourceDir);
    const jsonFiles = entries.filter(name => name.endsWith(JSON_FILE_EXT));
    const records = [];
    for (const fileName of jsonFiles) {
      const src = path.join(sourceDir, fileName);
      const dst = path.join(backupSubDir, fileName);
      const rel = path.join(relDirName, fileName);
      records.push(await copyBackupEntry(src, dst, rel));
    }
    return records;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new StorageError(`Failed to read ${relDirName} directory for backup.`, error);
  }
}

async function verifyBackupFile(backupPath, file) {
  const filePath = resolveSafeRelPath(backupPath, file.relPath);
  const bytes = await readFile(filePath).catch(error => {
    throw new StorageError(`Backup verification failed: missing ${file.relPath}`, error);
  });
  if (bytes.byteLength !== file.sizeBytes) {
    throw new StorageError(`Backup verification failed: size mismatch for ${file.relPath}`);
  }
  const actualSha = computeBufferSha256(bytes);
  if (actualSha !== file.sha256) {
    throw new StorageError(`Backup verification failed: checksum mismatch for ${file.relPath}`);
  }
}

async function verifyBackupFiles(backupPath, files) {
  for (const file of files) {
    await verifyBackupFile(backupPath, file);
  }
}

async function copyRootConfigFiles(rootDir, backupPath) {
  const files = [];
  for (const name of [CATALOG_FILE_NAME, GLOSSARY_FILE_NAME, TERMINOLOGY_FILE_NAME]) {
    const src = path.join(rootDir, name);
    if (await checkPathExists(src)) {
      files.push(await copyBackupEntry(src, path.join(backupPath, name), name));
    }
  }
  return files;
}

/**
 * Creates a verified pre-migration backup snapshot of active storage indexes and projects.
 * Inputs: spec ({ dataDir: string, backupDirName?: string }).
 * Outputs: Promise<{ backupPath: string, manifest: object }>.
 * Side effects: Creates backup directory and writes copied files and manifest.json.
 * Failure modes: Throws StorageError if reading or writing files fails.
 * @param {{ dataDir: string, backupDirName?: string }} spec - Backup configuration.
 * @returns {Promise<{ backupPath: string, manifest: object }>} Created backup details.
 */
export async function createStorageBackup({ dataDir, backupDirName = STORAGE_BACKUP_DIR }) {
  const rootDir = path.resolve(dataDir);
  const backupId = `backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const backupPath = resolveSafeRelPath(rootDir, path.join(backupDirName, backupId));
  await mkdir(backupPath, { recursive: true });
  const rootFiles = await copyRootConfigFiles(rootDir, backupPath);
  const projFiles = await collectDirectoryJsonBackupFiles(
    path.join(rootDir, PROJECTS_DIR_NAME),
    path.join(backupPath, PROJECTS_DIR_NAME),
    PROJECTS_DIR_NAME
  );
  const jobFiles = await collectDirectoryJsonBackupFiles(
    path.join(rootDir, JOBS_DIR_NAME),
    path.join(backupPath, JOBS_DIR_NAME),
    JOBS_DIR_NAME
  );
  const files = [...rootFiles, ...projFiles, ...jobFiles];
  await verifyBackupFiles(backupPath, files);
  const manifest = { timestamp: new Date().toISOString(), sourceDataDir: rootDir, files };
  await writeAtomicFile(path.join(backupPath, MANIFEST_FILE_NAME), JSON.stringify(manifest, null, 2));
  return { backupPath, manifest };
}

async function restoreSingleBackupFile(backupPath, rootDir, file) {
  const source = resolveSafeRelPath(backupPath, file.relPath);
  const destination = resolveSafeRelPath(rootDir, file.relPath);
  const contents = await readFile(source);
  if (file.sha256) {
    const actualSha = computeBufferSha256(contents);
    if (actualSha !== file.sha256) {
      throw new StorageError(`Backup integrity verification failed for ${file.relPath}: SHA-256 mismatch.`);
    }
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeAtomicFile(destination, contents);
  return file.relPath;
}

/**
 * Atomically restores verified storage files from a pre-migration backup snapshot.
 * Inputs: spec ({ dataDir: string, backupPath: string }).
 * Outputs: Promise<{ rolledBack: boolean, restoredFiles: string[] }>.
 * Side effects: Atomically overwrites target files with backup versions.
 * Failure modes: Throws StorageError if manifest is missing or restore fails.
 * @param {{ dataDir: string, backupPath: string }} spec - Rollback configuration.
 * @returns {Promise<{ rolledBack: boolean, restoredFiles: string[] }>} Rollback outcome.
 */
export async function rollbackStorageBackup({ dataDir, backupPath }) {
  const rootDir = path.resolve(dataDir);
  const manifestPath = path.join(backupPath, MANIFEST_FILE_NAME);
  const manifest = await safeReadJson(manifestPath);
  if (!manifest?.files || !Array.isArray(manifest.files)) {
    throw new StorageError(`Cannot rollback: invalid backup manifest at ${manifestPath}`);
  }
  const restoredFiles = [];
  for (const file of manifest.files) {
    restoredFiles.push(await restoreSingleBackupFile(backupPath, rootDir, file));
  }
  return { rolledBack: true, restoredFiles };
}

function isCharacterLegacy(char) {
  if (!char || typeof char !== 'object' || Array.isArray(char)) return true;
  if (char.desc !== undefined || char.prompt !== undefined) return true;
  if (typeof char.id !== 'string' || !char.id.trim()) return true;
  if (typeof char.name !== 'string' || !char.name.trim()) return true;
  if (typeof char.description !== 'string' || !char.description.trim()) return true;
  if (!VALID_CATEGORIES.has(char.category)) return true;
  if (char.voiceScope !== SINGLE_VOICE_SCOPE || typeof char.isBuiltIn !== 'boolean') return true;
  if (typeof char.created_at !== 'string' || typeof char.updated_at !== 'string') return true;
  return false;
}

function isAnchorLegacy(anchor) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return true;
  if (typeof anchor.exactClone !== 'boolean') return true;
  if (typeof anchor.promptText !== 'string') return true;
  if (anchor.mimeType === OCTET_STREAM_MIME) return true;
  if (typeof anchor.characterId !== 'string' || !anchor.characterId.trim()) return true;
  if (typeof anchor.source !== 'string' || !anchor.source) return true;
  if (typeof anchor.created_at !== 'string' || typeof anchor.updated_at !== 'string') return true;
  return false;
}

function isCatalogLegacy(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return true;
  if (catalog.version !== CURRENT_CATALOG_VERSION) return true;
  if (!catalog.characters || Array.isArray(catalog.characters)) return true;
  if (!catalog.anchors || Array.isArray(catalog.anchors)) return true;
  const chars = Object.values(catalog.characters);
  if (chars.some(isCharacterLegacy)) return true;
  const anchors = Object.values(catalog.anchors);
  if (anchors.some(isAnchorLegacy)) return true;
  return false;
}

function isGlossaryLegacy(glossary) {
  if (!glossary) return false;
  if (Array.isArray(glossary)) return true;
  if (glossary.version !== CURRENT_GLOSSARY_VERSION) return true;
  if (!Array.isArray(glossary.rules)) return true;
  return false;
}

function isProjectLegacy(project) {
  if (!project || typeof project !== 'object') return true;
  if (project.schemaVersion !== CURRENT_PROJECT_SCHEMA_VERSION) return true;
  if (!project.type || !project.name || !Array.isArray(project.segments)) return true;
  if (typeof project.settings !== 'object' || project.settings === null) return true;
  return false;
}

async function checkProjectFileLegacy(projectsDir, fileName) {
  const proj = await safeReadJson(path.join(projectsDir, fileName));
  if (!proj || !isProjectLegacy(proj)) return null;
  return path.basename(fileName, JSON_FILE_EXT);
}

async function findLegacyProjectFiles(projectsDir) {
  try {
    const entries = await readdir(projectsDir);
    const validProjectFiles = entries.filter(isProjectUuidFileName);
    const legacyIds = [];
    for (const fileName of validProjectFiles) {
      const id = await checkProjectFileLegacy(projectsDir, fileName);
      if (id) legacyIds.push(id);
    }
    return legacyIds;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new StorageError('Failed to scan projects for migration check.', error);
  }
}

/**
 * Detects whether catalog, glossary, or projects have legacy schema formats.
 * Inputs: spec ({ dataDir: string }).
 * Outputs: Promise<{ catalogNeeded: boolean, glossaryNeeded: boolean, projectsNeeded: boolean, legacyProjectIds: string[], anyNeeded: boolean }>.
 * Side effects: none.
 * Failure modes: Throws StorageError on unreadable files.
 * @param {{ dataDir: string }} spec - Storage root directory.
 * @returns {Promise<{ catalogNeeded: boolean, glossaryNeeded: boolean, projectsNeeded: boolean, legacyProjectIds: string[], anyNeeded: boolean }>} Migration status.
 */
export async function detectStorageMigrationsNeeded({ dataDir }) {
  const rootDir = path.resolve(dataDir);
  const catalog = await safeReadJson(path.join(rootDir, CATALOG_FILE_NAME));
  const catalogNeeded = catalog !== null && isCatalogLegacy(catalog);
  const glossary = await safeReadJson(path.join(rootDir, GLOSSARY_FILE_NAME));
  const glossaryNeeded = glossary !== null && isGlossaryLegacy(glossary);
  const legacyProjectIds = await findLegacyProjectFiles(path.join(rootDir, PROJECTS_DIR_NAME));
  const projectsNeeded = legacyProjectIds.length > 0;
  const anyNeeded = catalogNeeded || glossaryNeeded || projectsNeeded;
  return { catalogNeeded, glossaryNeeded, projectsNeeded, legacyProjectIds, anyNeeded };
}

function buildLegacyCharacterBase(rawId, rawChar) {
  const description = rawChar?.description || rawChar?.desc || rawChar?.prompt || '';
  const category = VALID_CATEGORIES.has(rawChar?.category) ? rawChar.category : DEFAULT_CATEGORY;
  return {
    id: rawId,
    name: rawChar?.name || rawId,
    description,
    category,
    role: rawChar?.role || DEFAULT_ROLE,
    traits: rawChar?.traits || DEFAULT_TRAITS,
    voiceScope: SINGLE_VOICE_SCOPE,
    isBuiltIn: false,
  };
}

function normalizeLegacyCharacter(rawId, rawChar) {
  const normalized = normalizeSavedEntry(buildLegacyCharacterBase(rawId, rawChar));
  if (!normalized) {
    throw new ValidationError(`Character ${rawId} cannot be migrated: invalid data.`, 'character', 'INVALID_CHARACTER');
  }
  const nowIso = new Date().toISOString();
  return {
    ...normalized,
    created_at: typeof rawChar?.created_at === 'string' ? rawChar.created_at : nowIso,
    updated_at: nowIso,
    deleted_at: typeof rawChar?.deleted_at === 'string' ? rawChar.deleted_at : null,
  };
}

function resolveAnchorAudioMime(bytes, rawMime) {
  const candidate = typeof rawMime === 'string' ? rawMime.split(';')[0].trim().toLowerCase() : '';
  const effective = candidate === OCTET_STREAM_MIME ? '' : candidate;
  if (effective && ALLOWED_AUDIO_MIME_TYPES.has(effective)) return effective;
  if (bytes && hasValidAudioMagicBytes(bytes)) return DEFAULT_AUDIO_MIME;
  return effective || DEFAULT_AUDIO_MIME;
}

async function inspectAnchorAudioBinary(anchorsDir, audioFile, existingSha256) {
  const audioPath = path.join(anchorsDir, path.basename(audioFile));
  if (!(await checkPathExists(audioPath))) {
    return { audioBytes: null, sizeBytes: 0, sha256: existingSha256 || '' };
  }
  const audioBytes = await readFile(audioPath);
  const sha256 = existingSha256 || computeBufferSha256(audioBytes);
  return { audioBytes, sizeBytes: audioBytes.byteLength, sha256 };
}

function buildAnchorRecord({ rawId, rawAnchor, audioFile, inspected, mimeType, nowIso }) {
  return {
    characterId: rawId,
    label: rawAnchor?.label || rawId,
    source: rawAnchor?.source === 'upload' ? 'upload' : 'generated',
    takeId: rawAnchor?.takeId ? String(rawAnchor.takeId) : null,
    fileName: rawAnchor?.fileName || `character-${rawId}.wav`,
    mimeType,
    sizeBytes: inspected.sizeBytes || Number(rawAnchor?.sizeBytes) || 0,
    sha256: inspected.sha256,
    promptText: typeof rawAnchor?.promptText === 'string' ? rawAnchor.promptText : '',
    exactClone: Boolean(rawAnchor?.exactClone),
    audioFile,
    created_at: rawAnchor?.created_at || nowIso,
    updated_at: nowIso,
    deleted_at: rawAnchor?.deleted_at || null,
  };
}

async function normalizeLegacyAnchor(rawId, rawAnchor, anchorsDir) {
  const nowIso = new Date().toISOString();
  const audioFile = rawAnchor?.audioFile || `${rawId}.audio`;
  const inspected = await inspectAnchorAudioBinary(anchorsDir, audioFile, rawAnchor?.sha256);
  const mimeType = resolveAnchorAudioMime(inspected.audioBytes, rawAnchor?.mimeType);
  return buildAnchorRecord({ rawId, rawAnchor, audioFile, inspected, mimeType, nowIso });
}

function extractRawMap(rawCollection, keyProp = 'id') {
  if (!rawCollection) return {};
  if (Array.isArray(rawCollection)) {
    return Object.fromEntries(rawCollection.map(item => [item[keyProp] || item.id, item]));
  }
  return typeof rawCollection === 'object' ? rawCollection : {};
}

/**
 * Upgrades a legacy character catalog and associated voice anchors to version 1.
 * Inputs: catalogPath (string), anchorsDir (string).
 * Outputs: Promise<{ migrated: boolean, characterCount: number, anchorCount: number }>.
 * Side effects: Atomically replaces catalogPath with versioned catalog.
 * Failure modes: Throws ValidationError or StorageError.
 * @param {string} catalogPath - Path to catalog.json.
 * @param {string} anchorsDir - Path to anchors directory.
 * @returns {Promise<{ migrated: boolean, characterCount: number, anchorCount: number }>} Result.
 */
export async function migrateCatalogFile(catalogPath, anchorsDir) {
  const raw = await safeReadJson(catalogPath);
  if (!raw) return { migrated: false, characterCount: 0, anchorCount: 0 };
  const rawChars = extractRawMap(raw.characters, 'id');
  const characters = {};
  for (const [id, char] of Object.entries(rawChars)) {
    characters[id] = normalizeLegacyCharacter(id, char);
  }
  const rawAnchors = extractRawMap(raw.anchors, 'characterId');
  const anchors = {};
  for (const [id, anchor] of Object.entries(rawAnchors)) {
    anchors[id] = await normalizeLegacyAnchor(id, anchor, anchorsDir);
  }
  const updated = { version: CURRENT_CATALOG_VERSION, characters, anchors };
  await writeAtomicFile(catalogPath, JSON.stringify(updated, null, 2));
  return { migrated: true, characterCount: Object.keys(characters).length, anchorCount: Object.keys(anchors).length };
}

function mapLegacyRule(rule) {
  if (!rule || typeof rule !== 'object') return rule;
  return {
    id: rule.id,
    source: rule.source || rule.find || rule.word || rule.from || '',
    replacement: rule.replacement ?? rule.replace ?? rule.to ?? '',
    enabled: rule.enabled !== false,
  };
}

/**
 * Upgrades a legacy glossary format (e.g. raw array or unversioned object) to version 1.
 * Inputs: glossaryPath (string).
 * Outputs: Promise<{ migrated: boolean, ruleCount: number }>.
 * Side effects: Atomically writes versioned glossary.json.
 * Failure modes: Throws StorageError.
 * @param {string} glossaryPath - Path to glossary.json.
 * @returns {Promise<{ migrated: boolean, ruleCount: number }>} Result.
 */
export async function migrateGlossaryFile(glossaryPath) {
  const raw = await safeReadJson(glossaryPath);
  if (!raw) return { migrated: false, ruleCount: 0 };
  const rawRules = Array.isArray(raw) ? raw : (raw.rules || []);
  const normalizedRules = normalizeGlossaryRules(rawRules.map(mapLegacyRule));
  const nowIso = new Date().toISOString();
  const updated = {
    version: CURRENT_GLOSSARY_VERSION,
    rules: normalizedRules,
    createdAt: raw.createdAt || nowIso,
    updatedAt: nowIso,
  };
  await writeAtomicFile(glossaryPath, JSON.stringify(updated, null, 2));
  return { migrated: true, ruleCount: normalizedRules.length };
}

/**
 * Upgrades a single project document on disk to project schema version 1.
 * Inputs: filePath (string).
 * Outputs: Promise<{ migrated: boolean, projectId: string }>.
 * Side effects: Atomically writes updated project document to filePath.
 * Failure modes: Throws ValidationError or StorageError.
 * @param {string} filePath - Absolute path to project JSON file.
 * @returns {Promise<{ migrated: boolean, projectId: string }>} Result.
 */
export async function migrateSingleProjectFile(filePath) {
  const raw = await safeReadJson(filePath);
  const fileName = path.basename(filePath);
  if (!isProjectUuidFileName(fileName) || !raw) {
    return { migrated: false, projectId: path.basename(filePath, JSON_FILE_EXT) };
  }
  const upgraded = upgradeProjectSchema(raw);
  await writeAtomicFile(filePath, JSON.stringify(upgraded, null, 2));
  return { migrated: true, projectId: upgraded.id };
}

/**
 * Migrates multiple project documents to schema version 1.
 * Inputs: projectsDir (string), projectIds (string[]).
 * Outputs: Promise<Array<{ migrated: boolean, projectId: string }>>.
 * Side effects: Atomically writes updated project documents.
 * Failure modes: Throws on IO or validation failure.
 * @param {string} projectsDir - Target projects directory.
 * @param {string[]} projectIds - List of project UUIDs to migrate.
 * @returns {Promise<Array<{ migrated: boolean, projectId: string }>>} Results.
 */
export async function migrateProjectFiles(projectsDir, projectIds) {
  const results = [];
  for (const id of projectIds) {
    const filePath = path.join(projectsDir, `${id}${JSON_FILE_EXT}`);
    results.push(await migrateSingleProjectFile(filePath));
  }
  return results;
}

async function executeMigrationSteps(ctx) {
  const applied = [];
  if (ctx.catalogNeeded) {
    await migrateCatalogFile(ctx.catalogPath, ctx.anchorsDir);
    applied.push('catalog-v1');
  }
  if (ctx.glossaryNeeded) {
    await migrateGlossaryFile(ctx.glossaryPath);
    applied.push('glossary-v1');
  }
  if (ctx.projectsNeeded) {
    await migrateProjectFiles(ctx.projectsDir, ctx.legacyProjectIds);
    applied.push('projects-v1');
  }
  return applied;
}

async function handleMigrationFailure(error, dataDir, backupPath) {
  try {
    await rollbackStorageBackup({ dataDir, backupPath });
  } catch (rollbackError) {
    throw new AggregateError([error, rollbackError], 'Storage migration failed and rollback encountered an error.');
  }
  throw new StorageError(`Storage migration failed: ${error.message}. Successfully rolled back.`, error);
}

function buildMigrationContext(rootDir, check) {
  return {
    ...check,
    catalogPath: path.join(rootDir, CATALOG_FILE_NAME),
    anchorsDir: path.join(rootDir, ANCHORS_DIR_NAME),
    glossaryPath: path.join(rootDir, GLOSSARY_FILE_NAME),
    projectsDir: path.join(rootDir, PROJECTS_DIR_NAME),
  };
}

/**
 * Runs versioned storage migration with automatic pre-migration backup and rollback.
 * Inputs: spec ({ dataDir: string, forceBackup?: boolean, logger?: object, customSteps?: Function }).
 * Outputs: Promise<{ migrated: boolean, backupPath: string|null, applied: string[] }>.
 * Side effects: Creates backup, upgrades disk files, or rolls back on error.
 * Failure modes: Throws StorageError if migration fails (after rollback).
 * @param {{ dataDir: string, forceBackup?: boolean, logger?: object, customSteps?: Function }} spec - Options.
 * @returns {Promise<{ migrated: boolean, backupPath: string|null, applied: string[] }>} Migration summary.
 */
export async function runStorageMigrations({ dataDir, forceBackup = false, logger = null, customSteps = null }) {
  const rootDir = path.resolve(dataDir);
  const check = await detectStorageMigrationsNeeded({ dataDir: rootDir });
  if (!check.anyNeeded && !forceBackup && !customSteps) {
    return { migrated: false, backupPath: null, applied: [] };
  }
  const { backupPath } = await createStorageBackup({ dataDir: rootDir });
  logger?.info?.('Created pre-migration storage backup', { backupPath });
  try {
    const ctx = buildMigrationContext(rootDir, check);
    const applied = customSteps ? await customSteps(ctx) : await executeMigrationSteps(ctx);
    logger?.info?.('Storage migration completed', { applied, backupPath });
    return { migrated: true, backupPath, applied };
  } catch (error) {
    logger?.error?.('Storage migration failed, rolling back', { errorMessage: error?.message, backupPath });
    return handleMigrationFailure(error, rootDir, backupPath);
  }
}

async function checkAnchorIntegrity(anchorsDir, id, anchor) {
  if (!anchor.audioFile) return null;
  const audioPath = path.join(anchorsDir, path.basename(anchor.audioFile));
  try {
    const bytes = await readFile(audioPath);
    if (!hasValidAudioMagicBytes(bytes)) {
      return `Anchor ${id} audio binary does not contain valid audio magic bytes: ${anchor.audioFile}`;
    }
    if (anchor.sha256 && computeBufferSha256(bytes) !== anchor.sha256) {
      return `Anchor ${id} audio checksum mismatch for ${anchor.audioFile}`;
    }
    return null;
  } catch (err) {
    if (err?.code === 'ENOENT') return `Anchor ${id} missing audio binary file: ${anchor.audioFile}`;
    return `Anchor ${id} audio read error: ${err.message}`;
  }
}

async function verifyCatalogIntegrity(rootDir, issues) {
  const catalogPath = path.join(rootDir, CATALOG_FILE_NAME);
  try {
    const catalog = await safeReadJson(catalogPath);
    if (!catalog) return;
    const anchorsDir = path.join(rootDir, ANCHORS_DIR_NAME);
    for (const [id, anchor] of Object.entries(catalog.anchors || {})) {
      const issue = await checkAnchorIntegrity(anchorsDir, id, anchor);
      if (issue) issues.push(issue);
    }
  } catch (error) {
    issues.push(`Catalog corruption: ${error.message}`);
  }
}

async function verifyTerminologyIntegrity(rootDir, issues) {
  const terminologyPath = path.join(rootDir, TERMINOLOGY_FILE_NAME);
  if (!(await checkPathExists(terminologyPath))) return;
  try {
    const terminology = await safeReadJson(terminologyPath);
    if (!terminology || typeof terminology !== 'object' || Array.isArray(terminology) || !Array.isArray(terminology.terms)) {
      issues.push('Terminology corruption: terms property must be an array.');
      return;
    }
    normalizeTerminologyList(terminology.terms);
  } catch (error) {
    issues.push(`Terminology corruption: ${error.message}`);
  }
}

async function verifyGlossaryIntegrity(rootDir, issues) {
  const glossaryPath = path.join(rootDir, GLOSSARY_FILE_NAME);
  try {
    const glossary = await safeReadJson(glossaryPath);
    if (!glossary) return;
    if (glossary.rules && !Array.isArray(glossary.rules)) {
      issues.push('Glossary corruption: rules property must be an array.');
    }
  } catch (error) {
    issues.push(`Glossary corruption: ${error.message}`);
  }
}

async function checkSingleProjectIntegrity(projectsDir, fileName, issues) {
  try {
    await safeReadJson(path.join(projectsDir, fileName));
  } catch (error) {
    issues.push(`Project file corruption for ${fileName}: ${error.message}`);
  }
}

async function verifyProjectsIntegrity(rootDir, issues) {
  const projectsDir = path.join(rootDir, PROJECTS_DIR_NAME);
  try {
    const entries = await readdir(projectsDir);
    for (const fileName of entries.filter(isProjectUuidFileName)) {
      await checkSingleProjectIntegrity(projectsDir, fileName, issues);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') issues.push(`Projects scan error: ${error.message}`);
  }
}

async function checkSingleJobIntegrity(jobsDir, fileName, issues) {
  try {
    const parsed = await safeReadJson(path.join(jobsDir, fileName));
    if (parsed) normalizeProductionJob(parsed);
  } catch (error) {
    issues.push(`Job file corruption for ${fileName}: ${error.message}`);
  }
}

async function verifyJobsIntegrity(rootDir, issues) {
  const jobsDir = path.join(rootDir, JOBS_DIR_NAME);
  try {
    const entries = await readdir(jobsDir);
    for (const fileName of entries.filter(isProjectUuidFileName)) {
      await checkSingleJobIntegrity(jobsDir, fileName, issues);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') issues.push(`Jobs scan error: ${error.message}`);
  }
}

/**
 * Verifies storage data preservation and file integrity.
 * Inputs: spec ({ dataDir: string }).
 * Outputs: Promise<{ valid: boolean, issues: string[] }>.
 * Side effects: none.
 * Failure modes: Throws StorageError if storage read fails.
 * @param {{ dataDir: string }} spec - Storage root directory.
 * @returns {Promise<{ valid: boolean, issues: string[] }>} Verification report.
 */
export async function verifyStorageIntegrity({ dataDir }) {
  const rootDir = path.resolve(dataDir);
  const issues = [];
  await verifyCatalogIntegrity(rootDir, issues);
  await verifyGlossaryIntegrity(rootDir, issues);
  await verifyTerminologyIntegrity(rootDir, issues);
  await verifyProjectsIntegrity(rootDir, issues);
  await verifyJobsIntegrity(rootDir, issues);
  return { valid: issues.length === 0, issues };
}
