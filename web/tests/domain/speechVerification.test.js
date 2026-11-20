import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatVerificationSummary,
  formatVerifyReasonLabel,
  hasKhmerScript,
  resolveVerificationLanguage,
} from '../../src/domain/speechVerification.js';

test('hasKhmerScript and resolveVerificationLanguage classify Khmer vs multilingual scripts accurately', () => {
  assert.equal(hasKhmerScript('សួស្តី កម្ពុជា'), true);
  assert.equal(hasKhmerScript('Hello world 123'), false);
  assert.equal(hasKhmerScript(null), false);

  assert.equal(resolveVerificationLanguage('សួស្តី កម្ពុជា'), 'km');
  assert.equal(resolveVerificationLanguage('Hello world'), 'auto');
  assert.equal(resolveVerificationLanguage('   '), 'km');
});

test('formatVerificationSummary and formatVerifyReasonLabel map scores and reason codes safely', () => {
  assert.deepEqual(formatVerificationSummary({ verdict: 'pass', similarity: 0.942 }), {
    tone: 'pass',
    percent: 94,
    label: 'Verified · 94%',
  });
  assert.deepEqual(formatVerificationSummary({ verdict: 'warn', similarity: 0.72 }), {
    tone: 'warn',
    percent: 72,
    label: 'Check pronunciation · 72%',
  });
  assert.deepEqual(formatVerificationSummary({ verdict: 'fail', similarity: -1 }), {
    tone: 'fail',
    percent: 0,
    label: 'Mismatch · 0%',
  });

  assert.equal(formatVerifyReasonLabel('whisper_fallback'), 'Whisper recovery');
  assert.equal(formatVerifyReasonLabel('high_oov'), 'Whisper check');
  assert.equal(formatVerifyReasonLabel('double_check'), 'Whisper double-check');
  assert.equal(formatVerifyReasonLabel('other'), 'Whisper suggestion');
});
