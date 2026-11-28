import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expandKhmerNumbers } from '../src/domain/khmerText.js';

const fixturePath = new URL('../evals/UX2-02-khmer-normalization.json', import.meta.url);
const fixture = JSON.parse(await readFile(fileURLToPath(fixturePath), 'utf8'));
const cases = fixture.cases;
if (!Array.isArray(cases) || cases.length < 50 || cases.length > 100) {
  throw new Error(`UX2-02 eval corpus must contain 50–100 cases; found ${cases?.length ?? 0}.`);
}
if (new Set(cases.map(item => item.id)).size !== cases.length) {
  throw new Error('UX2-02 eval corpus contains duplicate case IDs.');
}
const failures = [];
const categoryTotals = new Map();
const categoryPassed = new Map();

for (const item of cases) {
  const actual = expandKhmerNumbers(item.input);
  const total = categoryTotals.get(item.category) || 0;
  categoryTotals.set(item.category, total + 1);
  if (actual === item.expected) {
    categoryPassed.set(item.category, (categoryPassed.get(item.category) || 0) + 1);
  } else {
    failures.push({ ...item, actual });
  }
}

console.log(`${fixture.id}: ${cases.length} cases; ${cases.length - failures.length}/${cases.length} exact matches`);
for (const [category, total] of categoryTotals) {
  console.log(`  ${category}: ${categoryPassed.get(category) || 0}/${total}`);
}
console.log(`  Human review: ${fixture.reviewStatus}`);

if (failures.length) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.id}\n  expected: ${failure.expected}\n  actual:   ${failure.actual}`);
  }
  process.exitCode = 1;
}
