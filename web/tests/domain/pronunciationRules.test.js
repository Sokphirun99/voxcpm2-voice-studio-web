import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../../src/domain/errors.js';
import { validateGenerationInput } from '../../src/domain/presets.js';
import {
  MAX_GLOSSARY_RULES,
  MAX_GLOSSARY_TERM_LENGTH,
  applyPronunciationRules,
  normalizeGlossaryRules,
} from '../../src/domain/pronunciationRules.js';

const rule = (source, replacement, extra = {}) => ({ source, replacement, ...extra });
const codeOf = fn => { try { fn(); } catch (error) { return error; } return null; };

test('normalizeGlossaryRules trims, defaults enabled, assigns ids, and normalizes Khmer Unicode', () => {
  const rules = normalizeGlossaryRules([
    { source: '  NASA  ', replacement: ' nah-sah ' },
    { id: 'custom-id', source: 'អ៊ីម៉ែល', replacement: 'អ៊ី មែល', enabled: false },
  ]);
  assert.deepEqual(rules, [
    { id: 'rule-1', source: 'NASA', replacement: 'nah-sah', enabled: true },
    { id: 'custom-id', source: 'អ៊ីម៉ែល', replacement: 'អ៊ី មែល', enabled: false },
  ]);
});

test('normalizeGlossaryRules rejects empty sources, over-long terms, bad shapes, and duplicates with typed errors', () => {
  const cases = [
    [[rule('   ', 'x')], 'EMPTY_GLOSSARY_SOURCE'],
    [[rule(undefined, 'x')], 'EMPTY_GLOSSARY_SOURCE'],
    [[rule('a'.repeat(MAX_GLOSSARY_TERM_LENGTH + 1), 'x')], 'GLOSSARY_TERM_TOO_LONG'],
    [[rule('x', 'b'.repeat(MAX_GLOSSARY_TERM_LENGTH + 1))], 'GLOSSARY_TERM_TOO_LONG'],
    [[rule('x', 42)], 'INVALID_GLOSSARY_TERM'],
    [[rule('x', 'y', { enabled: 'yes' })], 'INVALID_GLOSSARY_RULE'],
    [['NASA'], 'INVALID_GLOSSARY_RULE'],
    [[rule('dup', 'a'), rule('dup', 'b')], 'DUPLICATE_GLOSSARY_SOURCE'],
    [{ source: 'x' }, 'INVALID_GLOSSARY_RULES'],
    [null, 'INVALID_GLOSSARY_RULES'],
  ];
  for (const [input, code] of cases) {
    const error = codeOf(() => normalizeGlossaryRules(input));
    assert.ok(error instanceof ValidationError, `expected ValidationError for ${code}`);
    assert.equal(error.code, code);
    assert.equal(error.field, 'rules');
  }
});

test('normalizeGlossaryRules allows exactly 120-character terms and an empty replacement but caps at 200 rules', () => {
  const edge = normalizeGlossaryRules([rule('s'.repeat(MAX_GLOSSARY_TERM_LENGTH), 'r'.repeat(MAX_GLOSSARY_TERM_LENGTH)), rule('mute-me', '')]);
  assert.equal(edge.length, 2);
  assert.equal(edge[1].replacement, '');

  const full = Array.from({ length: MAX_GLOSSARY_RULES }, (_, index) => rule(`term-${index}`, `say-${index}`));
  assert.equal(normalizeGlossaryRules(full).length, MAX_GLOSSARY_RULES);
  const tooMany = codeOf(() => normalizeGlossaryRules([...full, rule('one-more', 'x')]));
  assert.equal(tooMany.code, 'GLOSSARY_TOO_MANY_RULES');
});

test('normalizeGlossaryRules does not mutate its input', () => {
  const raw = [{ source: '  NASA ', replacement: 'x' }];
  const snapshot = JSON.stringify(raw);
  normalizeGlossaryRules(raw);
  assert.equal(JSON.stringify(raw), snapshot);
});

test('applyPronunciationRules replaces Latin terms and mixed Khmer/English terms', () => {
  assert.equal(applyPronunciationRules('Call NASA about Kubernetes.', [rule('NASA', 'nah-sah'), rule('Kubernetes', 'koo-ber-nay-teez')]),
    'Call nah-sah about koo-ber-nay-teez.');
  assert.equal(applyPronunciationRules('ខ្ញុំមាន iPhone ថ្មី និង Facebook', [rule('iPhone', 'អាយហ្វូន'), rule('Facebook', 'ហ្វេសប៊ុក')]),
    'ខ្ញុំមាន អាយហ្វូន ថ្មី និង ហ្វេសប៊ុក');
});

test('applyPronunciationRules replaces Khmer source terms inside unspaced Khmer text', () => {
  assert.equal(applyPronunciationRules('ខ្ញុំទៅភ្នំពេញថ្ងៃនេះ', [rule('ភ្នំពេញ', 'ភ្នំ ពេញ')]), 'ខ្ញុំទៅភ្នំ ពេញថ្ងៃនេះ');
});

test('applyPronunciationRules never splits a Khmer cluster (dependent vowel or coeng continuation)', () => {
  assert.equal(applyPronunciationRules('កា ក', [rule('ក', 'X')]), 'កា X');
  assert.equal(applyPronunciationRules('ក្ម ម', [rule('ម', 'X')]), 'ក្ម X');
});

test('applyPronunciationRules treats every regex metacharacter literally', () => {
  const text = 'price $5.00 (C++) [a] a*b? a\\b';
  const rules = [
    rule('$5.00', 'five dollars'),
    rule('(C++)', 'see plus plus'),
    rule('[a]', 'bracket a'),
    rule('a*b?', 'star'),
    rule('a\\b', 'backslash'),
  ];
  assert.equal(applyPronunciationRules(text, rules), 'price five dollars see plus plus bracket a star backslash');
  assert.equal(applyPronunciationRules('a.b axb', [rule('a.b', 'dot')]), 'dot axb');
  assert.equal(applyPronunciationRules('x|y xy', [rule('x|y', 'pipe')]), 'pipe xy');
});

test('applyPronunciationRules inserts replacements literally so $&, $$, $1, and $` never expand', () => {
  assert.equal(applyPronunciationRules('buy now', [rule('now', '$& $$ $1 $` $\'')]), 'buy $& $$ $1 $` $\'');
  assert.equal(applyPronunciationRules('cost: $&', [rule('$&', '$$')]), 'cost: $$');
});

test('applyPronunciationRules matches longest terms first regardless of rule order', () => {
  const rules = [rule('New', 'nu'), rule('New York', 'nyoo yorrk'), rule('New York City', 'nyoo yorrk sitty')];
  assert.equal(applyPronunciationRules('I love New York City and New York and New.', rules), 'I love nyoo yorrk sitty and nyoo yorrk and nu.');
  assert.equal(applyPronunciationRules('I love New York City and New York and New.', [...rules].reverse()), 'I love nyoo yorrk sitty and nyoo yorrk and nu.');
});

test('applyPronunciationRules does not cascade: replaced text is never rescanned', () => {
  assert.equal(applyPronunciationRules('a b', [rule('a', 'b'), rule('b', 'c')]), 'b c');
});

test('applyPronunciationRules keeps Latin terms on token boundaries so "AI" never rewrites "MAIN"', () => {
  assert.equal(applyPronunciationRules('MAIN AI, AI. tAIl', [rule('AI', 'ay eye')]), 'MAIN ay eye, ay eye. tAIl');
  assert.equal(applyPronunciationRules('C++ and C#', [rule('C++', 'see plus plus')]), 'see plus plus and C#');
});

test('applyPronunciationRules skips disabled, empty, and malformed rules and is a no-op without active rules', () => {
  const text = 'keep NASA';
  assert.equal(applyPronunciationRules(text, [rule('NASA', 'x', { enabled: false })]), text);
  assert.equal(applyPronunciationRules(text, [rule('', 'x'), null, { replacement: 'x' }, rule(5, 'x')]), text);
  assert.equal(applyPronunciationRules(text, undefined), text);
  assert.equal(applyPronunciationRules(text, []), text);
  assert.equal(applyPronunciationRules(undefined, [rule('a', 'b')]), '');
});

test('applyPronunciationRules lets the first duplicate source win and supports empty replacements', () => {
  assert.equal(applyPronunciationRules('um hello', [rule('um ', ''), rule('um ', 'x')]), 'hello');
});

test('validateGenerationInput applies enabled rules to the spoken text only and keeps the input script intact', () => {
  const input = {
    script: 'សួស្តី NASA',
    character: { id: 'narrator', description: 'Calm voice' },
    guidance: 2, steps: 10, seed: 7,
    pronunciationRules: [rule('NASA', 'ណាសា'), rule('សួស្តី', 'ជំរាបសួរ', { enabled: false })],
  };
  const snapshot = JSON.stringify(input);
  const payload = validateGenerationInput(input);
  assert.equal(payload.text, 'សួស្តី ណាសា');
  assert.equal(JSON.stringify(input), snapshot);
});

test('validateGenerationInput re-tidies spacing when a rule deletes text and rejects scripts erased entirely', () => {
  const base = { character: { id: 'narrator', description: 'Calm voice' }, guidance: 2, steps: 10, seed: 7 };
  assert.equal(validateGenerationInput({ ...base, script: 'hello um world', pronunciationRules: [rule('um', '')] }).text, 'hello world');
  const error = codeOf(() => validateGenerationInput({ ...base, script: 'um', pronunciationRules: [rule('um', '')] }));
  assert.equal(error.code, 'EMPTY_SCRIPT');
});

test('validateGenerationInput enforces the script length limit on the rewritten text', () => {
  const base = { character: { id: 'narrator', description: 'Calm voice' }, guidance: 2, steps: 10, seed: 7 };
  const script = Array.from({ length: 1000 }, () => 'x').join(' ');
  assert.equal(validateGenerationInput({ ...base, script }).text.length, 1999);
  const error = codeOf(() => validateGenerationInput({ ...base, script, pronunciationRules: [rule('x', 'xx')] }));
  assert.equal(error.code, 'SCRIPT_TOO_LONG');
});
