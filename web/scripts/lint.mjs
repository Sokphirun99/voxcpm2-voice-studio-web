/**
 * @fileoverview Zero-dependency static syntax and code-hygiene checker for `web/`.
 * Parses all JS/JSX/MJS files with Vite's Oxc parser and flags empty catch blocks.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIRS = ['src', 'server', 'tests', 'scripts'];
const SOURCE_EXTS = new Set(['.js', '.mjs', '.jsx']);
const EMPTY_CATCH_PATTERN = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

/**
 * Recursively collects JS/JSX/MJS file paths inside a directory.
 * @param {string} dir - Directory path to walk.
 * @returns {Promise<string[]>} Sorted list of file paths.
 */
async function collectSourceFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(full));
    } else if (SOURCE_EXTS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Validates syntax via Vite Oxc and checks for silent empty catch blocks.
 * @param {string} filePath - Target source file path.
 * @returns {Promise<string[]>} List of lint issue descriptions for this file.
 */
async function checkFile(filePath) {
  const issues = [];
  const code = await fs.readFile(filePath, 'utf8');
  const rel = path.relative(WEB_ROOT, filePath);
  try {
    const res = await transformWithOxc(code, filePath, { lang: filePath.endsWith('.jsx') ? 'jsx' : 'js' });
    if (Array.isArray(res?.errors) && res.errors.length > 0) {
      issues.push(`${rel}: syntax/parse error: ${res.errors.map(e => e?.message || String(e)).join('; ')}`);
    }
  } catch (err) {
    issues.push(`${rel}: syntax/parse error: ${err?.message || err}`);
  }
  if (!rel.startsWith(`tests${path.sep}`) && !rel.startsWith(`scripts${path.sep}`)) {
    const match = code.match(EMPTY_CATCH_PATTERN);
    if (match) {
      issues.push(`${rel}: found empty catch block (${match[0].trim()})`);
    }
  }
  return issues;
}

async function main() {
  const groups = await Promise.all(TARGET_DIRS.map(dir => collectSourceFiles(path.join(WEB_ROOT, dir))));
  const files = groups.flat().sort();
  const results = await Promise.all(files.map(checkFile));
  const failures = results.flat();
  if (failures.length > 0) {
    console.error(`Lint failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):\n${failures.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Lint passed (${files.length} files checked).`);
}

await main();
