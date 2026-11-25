import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../../src/domain/errors.js';
import {
  TERM_CATEGORIES,
  TERM_STATUSES,
  applySpellingTerms,
  applyTranslationTerms,
  applyTtsPronunciationTerms,
  buildPronunciationSignature,
  clearProjectTermOverride,
  createEmptyProjectTerminology,
  doesTerminologyLanguageMatch,
  inspectSegmentTerminology,
  normalizeProjectTerminology,
  normalizeTerminologyList,
  normalizeTerminologyTerm,
  promoteProjectTermToGlobal,
  removeProjectTerm,
  resolveEffectiveTerminology,
  selectPronunciationRules,
  selectSpellingRules,
  selectTranslationRules,
  setProjectTermOverride,
  upsertProjectTerm,
} from '../../src/domain/terminology.js';

test('terminology normalization enforces category rules, bounds, and defaults omitted status to draft', () => {
  const draftDefault = normalizeTerminologyTerm({
    category: TERM_CATEGORIES.SPELLING,
    term: 'Phnom Penh',
    variants: ['Pnom Penh', 'Phnom Penh', 'Phom Penh'],
  });
  assert.equal(draftDefault.status, TERM_STATUSES.DRAFT);
  assert.deepEqual(draftDefault.variants, ['Pnom Penh', 'Phom Penh']);
  assert.equal(draftDefault.translation, '');
  assert.equal(draftDefault.pronunciation, '');

  assert.throws(
    () => normalizeTerminologyTerm({ category: TERM_CATEGORIES.TRANSLATION, term: 'AI', status: 'approved' }),
    error => error instanceof ValidationError && error.code === 'EMPTY_TERMINOLOGY_TRANSLATION'
  );
  assert.throws(
    () => normalizeTerminologyTerm({ category: 'bogus', term: 'x' }),
    error => error instanceof ValidationError && error.code === 'INVALID_TERMINOLOGY_CATEGORY'
  );
  assert.throws(
    () => normalizeTerminologyList([
      { id: 't1', category: 'spelling', term: 'VoxCPM' },
      { id: 't2', category: 'spelling', term: 'voxcpm' },
    ]),
    error => error instanceof ValidationError && error.code === 'DUPLICATE_TERMINOLOGY_TERM'
  );
});

test('draft or disabled terms never apply automatically until approved and enabled', () => {
  const rawTerms = [
    { id: 'd1', category: 'spelling', status: 'draft', term: 'VoxCPM', variants: ['vox cpm'] },
    { id: 'd2', category: 'translation', status: 'draft', term: 'AI', translation: 'បញ្ញាសិប្បនិម្មិត', targetLanguage: 'khm_Khmr' },
    { id: 'd3', category: 'pronunciation', status: 'approved', enabled: false, term: 'API', pronunciation: 'អេភីអាយ' },
  ];
  const effective = resolveEffectiveTerminology(rawTerms);
  assert.equal(applySpellingTerms('Use vox cpm now.', effective), 'Use vox cpm now.');
  assert.equal(applyTranslationTerms('AI is here', effective, { targetLanguage: 'khm_Khmr' }), 'AI is here');
  assert.equal(applyTtsPronunciationTerms('Call the API', effective), 'Call the API');

  const approved = resolveEffectiveTerminology(rawTerms.map(item => ({ ...item, status: 'approved', enabled: true })));
  assert.equal(applySpellingTerms('Use vox cpm now.', approved), 'Use VoxCPM now.');
  assert.equal(applyTranslationTerms('AI is here', approved, { targetLanguage: 'khm_Khmr' }), 'បញ្ញាសិប្បនិម្មិត is here');
  assert.equal(applyTtsPronunciationTerms('Call the API', approved), 'Call the អេភីអាយ');
});

test('correction stages remain strictly isolated across spelling, translation, name, and TTS pronunciation', () => {
  const effective = resolveEffectiveTerminology([
    {
      id: 'spell-1',
      category: 'spelling',
      status: 'approved',
      term: 'Phnom Penh',
      variants: ['Pnom Penh'],
      translation: 'should-be-stripped',
      pronunciation: 'should-be-stripped',
    },
    {
      id: 'tr-1',
      category: 'translation',
      status: 'approved',
      term: 'Workspace',
      translation: 'កន្លែងធ្វើការ',
      sourceLanguage: 'en',
      targetLanguage: 'khm_Khmr',
    },
    {
      id: 'name-1',
      category: 'name',
      status: 'approved',
      term: 'VoxCPM',
      variants: ['vox cpm'],
      preserveInTranslation: true,
      pronunciation: 'វ៉ុកស៊ីភីអឹម',
    },
    {
      id: 'name-silent-check',
      category: 'name',
      status: 'approved',
      term: 'Sovann',
      variants: ['Sovan'],
      pronunciation: '',
    },
    {
      id: 'pron-1',
      category: 'pronunciation',
      status: 'approved',
      term: 'Phnom Penh',
      pronunciation: 'ភ្នំពេញ',
    },
    {
      id: 'pron-omit',
      category: 'pronunciation',
      status: 'approved',
      term: '[um]',
      pronunciation: '',
    },
  ]);

  // Stage 1: Spelling fixes ONLY source orthography, never injects translation or pronunciation
  const stage1 = applySpellingTerms('Sovan visited Pnom Penh with vox cpm [pause 500ms].', effective, { sourceLanguage: 'en' });
  assert.equal(stage1, 'Sovann visited Phnom Penh with VoxCPM [pause 500ms].');
  assert.equal(stage1.includes('វ៉ុកស៊ីភីអឹម'), false);
  assert.equal(stage1.includes('កន្លែងធ្វើការ'), false);

  // Stage 2: Translation reads only translation + name entries matching target language, never pronunciation
  assert.deepEqual(selectTranslationRules(effective, { sourceLanguage: 'en', targetLanguage: 'fra_Latn' }).map(r => r.source), ['VoxCPM']);
  const trRulesKm = selectTranslationRules(effective, { sourceLanguage: 'en', targetLanguage: 'km' });
  assert.deepEqual(trRulesKm.map(r => [r.source, r.target]), [['Workspace', 'កន្លែងធ្វើការ'], ['VoxCPM', 'VoxCPM']]);

  // Stage 3: Pronunciation applies only pronunciation + name with non-empty pronunciation; name with empty pronunciation stays spoken verbatim; pauses stay intact
  const spoken = applyTtsPronunciationTerms('Sovann visited Phnom Penh using VoxCPM [um] [pause 0.5s]', effective);
  assert.equal(spoken, 'Sovann visited ភ្នំពេញ using វ៉ុកស៊ីភីអឹម [pause 0.5s]');

  // Stage 4: Subtitle cue inspection never flags TTS pronunciation entries as subtitle issues
  const diag = inspectSegmentTerminology(
    { text: 'Sovan went to Phnom Penh Workspace.', translatedText: 'សុវណ្ណទៅកន្លែងធ្វើការមិនទាន់ត្រូវ។' },
    effective,
    { sourceLanguage: 'en', targetLanguage: 'khm_Khmr' }
  );
  assert.equal(diag.spellingMatches.length, 1);
  assert.equal(diag.spellingMatches[0].target, 'Sovann');
  assert.equal(diag.translationGaps.length, 0);
});

test('boundary guards prevent partial-word Latin corruption and mid-cluster Khmer breaks', () => {
  const effective = resolveEffectiveTerminology([
    { id: 't1', category: 'spelling', status: 'approved', term: 'AI', variants: ['ai'] },
    { id: 't2', category: 'pronunciation', status: 'approved', term: 'ក', pronunciation: 'កខគ' },
  ]);
  assert.equal(applySpellingTerms('MAIN domain ai tool', effective), 'MAIN domain AI tool');
  assert.equal(applyTtsPronunciationTerms('ក្បាល ក', effective), 'ក្បាល កខគ');
});

test('per-project overrides, disables, project-only terms, resets, and promotions behave deterministically', () => {
  const globals = normalizeTerminologyList([
    { id: 'g-spell', category: 'spelling', status: 'approved', term: 'Phnom Penh', variants: ['Pnom Penh'] },
    { id: 'g-tr', category: 'translation', status: 'approved', term: 'Studio', translation: 'ស្ទូឌីយោ', targetLanguage: 'khm_Khmr' },
    { id: 'g-pron', category: 'pronunciation', status: 'approved', term: 'TTS', pronunciation: 'ធីធីអេស' },
  ]);

  // Project A overrides translation and disables spelling rule
  let projA = createEmptyProjectTerminology();
  projA = setProjectTermOverride(projA, 'g-tr', { translation: 'រោងស្ទូឌីយោ' });
  projA = setProjectTermOverride(projA, 'g-spell', { disabled: true });
  projA = upsertProjectTerm(projA, {
    id: 'p-only',
    category: 'pronunciation',
    status: 'approved',
    term: 'TTS',
    pronunciation: 'ថេកស៍ធូស្ពីច',
  });

  // Global library resolves identically in Project B (clean empty overrides)
  const effectiveB = resolveEffectiveTerminology(globals, createEmptyProjectTerminology());
  const effectiveA = resolveEffectiveTerminology(globals, projA);

  assert.equal(applySpellingTerms('In Pnom Penh', effectiveB), 'In Phnom Penh');
  assert.equal(applySpellingTerms('In Pnom Penh', effectiveA), 'In Pnom Penh');

  assert.equal(selectTranslationRules(effectiveB, { targetLanguage: 'khm_Khmr' })[0].target, 'ស្ទូឌីយោ');
  assert.equal(selectTranslationRules(effectiveA, { targetLanguage: 'khm_Khmr' })[0].target, 'រោងស្ទូឌីយោ');

  // Project-scoped pronunciation term wins over global pronunciation on collision
  assert.equal(applyTtsPronunciationTerms('Run TTS', effectiveA), 'Run ថេកស៍ធូស្ពីច');
  assert.equal(applyTtsPronunciationTerms('Run TTS', effectiveB), 'Run ធីធីអេស');

  // Reset restores global rule cleanly
  projA = clearProjectTermOverride(projA, 'g-spell');
  assert.equal(applySpellingTerms('In Pnom Penh', resolveEffectiveTerminology(globals, projA)), 'In Phnom Penh');

  // Remove & promote project-only term
  const differentProj = upsertProjectTerm(createEmptyProjectTerminology(), {
    id: 'proj-new',
    category: 'name',
    status: 'approved',
    term: 'OpenBMB',
    variants: ['open bmb'],
    preserveInTranslation: true,
    pronunciation: 'អូផឹនប៊ីអឹមប៊ី',
  });
  const promoted = promoteProjectTermToGlobal(differentProj, 'proj-new', globals);
  assert.equal(promoted.globalTerms.length, 4);
  assert.equal(promoted.projectTerminology.projectTerms.length, 0);
  assert.equal(promoted.promotedTerm.term, 'OpenBMB');

  const removed = removeProjectTerm(projA, 'p-only');
  assert.equal(removed.projectTerms.length, 0);
});

test('doesTerminologyLanguageMatch maps ISO and FLORES codes cleanly and pronunciation signature isolates Stage 3', () => {
  assert.equal(doesTerminologyLanguageMatch('', 'km'), true);
  assert.equal(doesTerminologyLanguageMatch('en', 'eng_Latn'), true);
  assert.equal(doesTerminologyLanguageMatch('km', 'khm_Khmr'), true);
  assert.equal(doesTerminologyLanguageMatch('km', 'eng_Latn'), false);
  assert.equal(doesTerminologyLanguageMatch('en', ''), false);

  const spellOnly = resolveEffectiveTerminology([
    { id: 's1', category: 'spelling', status: 'approved', term: 'VoxCPM', variants: ['vox cpm'] },
  ]);
  assert.equal(buildPronunciationSignature(spellOnly, [], 'en'), '');

  const withPron = resolveEffectiveTerminology([
    { id: 's1', category: 'spelling', status: 'approved', term: 'VoxCPM', variants: ['vox cpm'] },
    { id: 'p1', category: 'pronunciation', status: 'approved', term: 'VoxCPM', pronunciation: 'វ៉ុក' },
  ]);
  assert.notEqual(buildPronunciationSignature(withPron, [], 'en'), '');
});


import * as termReg from '../../src/domain/terminology.js';
import * as errReg from '../../src/domain/errors.js';

test('regression: mixed case-sensitive and case-insensitive rules never shadow shorter matches', () => {
  const terms = [
    {
      id: 'cs-rule',
      category: 'spelling',
      term: 'CARE',
      variants: ['WHO cares'],
      caseSensitive: true,
      status: 'approved',
    },
    {
      id: 'ci-rule',
      category: 'spelling',
      term: 'whom',
      variants: ['who'],
      caseSensitive: false,
      status: 'approved',
    },
  ];
  assert.equal(termReg.applySpellingTerms('who cares', terms), 'whom cares');
  assert.equal(termReg.applySpellingTerms('WHO cares and who asks', terms), 'CARE and whom asks');
});

test('regression: canonical and target identity guards prevent double-rewriting containing shorter variants', () => {
  const spellingTerms = [
    {
      id: 'sp-name',
      category: 'name',
      term: 'Dr. Sok',
      variants: ['Sok'],
      status: 'approved',
    },
  ];
  assert.equal(
    termReg.applySpellingTerms('Meet Dr. Sok and Sok today.', spellingTerms),
    'Meet Dr. Sok and Dr. Sok today.'
  );
  assert.equal(
    termReg.applySpellingTerms('Dr. Sok met Dr. Sok.', spellingTerms),
    'Dr. Sok met Dr. Sok.'
  );

  const translationTerms = [
    {
      id: 'tr-studio',
      category: 'translation',
      term: 'Studio',
      translation: 'Voice Studio',
      sourceLanguage: 'en',
      targetLanguage: 'en',
      status: 'approved',
    },
  ];
  assert.equal(
    termReg.applyTranslationTerms('Welcome to Voice Studio and Studio', translationTerms, { sourceLanguage: 'en', targetLanguage: 'en' }),
    'Welcome to Voice Studio and Voice Studio'
  );
});

test('regression: setProjectTermOverride validates merged entity and replace mode removes cleared fields', () => {
  const globalTerms = [
    {
      id: 'g-tr',
      category: 'translation',
      term: 'AI',
      translation: 'បញ្ញា',
      sourceLanguage: 'en',
      targetLanguage: 'km',
      status: 'approved',
    },
    {
      id: 'g-sp',
      category: 'spelling',
      term: 'VoxCPM2',
      variants: ['voxcpm'],
      status: 'approved',
    },
  ];
  let project = termReg.setProjectTermOverride(
    termReg.createEmptyProjectTerminology(),
    'g-sp',
    { variants: ['vox-cpm'], notes: 'keep note' },
    globalTerms
  );

  assert.throws(
    () => termReg.setProjectTermOverride(project, 'g-tr', { translation: '' }, globalTerms),
    errReg.ValidationError
  );
  // Previous valid override must remain intact after rejected override
  const { updatedAt: keepTs, ...keepFields } = project.overrides['g-sp'];
  assert.ok(keepTs);
  assert.deepEqual(keepFields, { variants: ['vox-cpm'], notes: 'keep note' });

  // Replace mode drops fields omitted from the minimal diff patch
  project = termReg.setProjectTermOverride(project, 'g-sp', { variants: ['vox-cpm'] }, globalTerms, { replace: true });
  const { updatedAt: replacedTs, ...replacedFields } = project.overrides['g-sp'];
  assert.ok(replacedTs);
  assert.deepEqual(replacedFields, { variants: ['vox-cpm'] });
});
