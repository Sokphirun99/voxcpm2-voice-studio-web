/**
 * @fileoverview Complete offline subtitle language catalog covering all 100 Whisper ASR languages (+ auto)
 * and all 202 Meta NLLB-200 FLORES-200 translation target languages, plus pure resolution helpers.
 */

export const DEFAULT_SOURCE_LANGUAGE = 'km';
export const DEFAULT_KHMER_TARGET = 'khm_Khmr';
export const DEFAULT_ENGLISH_TARGET = 'eng_Latn';

const RTL_SCRIPT_SUFFIXES = Object.freeze(['_Arab', '_Hebr']);

export const POPULAR_SOURCE_LANGUAGE_IDS = Object.freeze([
  'auto',
  'km',
  'en',
  'zh',
  'yue',
  'th',
  'vi',
  'lo',
  'my',
  'ja',
  'ko',
  'fr',
  'es',
  'de',
  'ru',
  'ar',
  'hi',
  'id',
  'ms',
  'pt',
  'it',
]);

export const POPULAR_TARGET_LANGUAGE_IDS = Object.freeze([
  'khm_Khmr',
  'eng_Latn',
  'zho_Hans',
  'zho_Hant',
  'yue_Hant',
  'tha_Thai',
  'vie_Latn',
  'lao_Laoo',
  'mya_Mymr',
  'jpn_Jpan',
  'kor_Hang',
  'fra_Latn',
  'spa_Latn',
  'deu_Latn',
  'rus_Cyrl',
  'arb_Arab',
  'hin_Deva',
  'ind_Latn',
  'zsm_Latn',
  'por_Latn',
  'ita_Latn',
]);

/**
 * All 101 Whisper ASR source language options (`auto` + all 100 `mlx_whisper` languages).
 */
export const SOURCE_LANGUAGE_OPTIONS = Object.freeze([
  { id: 'auto', label: 'Auto-detect language' },
  { id: 'km', label: 'Khmer (ខ្មែរ)' },
  { id: 'en', label: 'English' },
  { id: 'zh', label: 'Chinese (中文)' },
  { id: 'yue', label: 'Cantonese (粵語)' },
  { id: 'th', label: 'Thai (ไทย)' },
  { id: 'vi', label: 'Vietnamese (Tiếng Việt)' },
  { id: 'lo', label: 'Lao (ລາວ)' },
  { id: 'my', label: 'Burmese / Myanmar (မြန်မာ)' },
  { id: 'ja', label: 'Japanese (日本語)' },
  { id: 'ko', label: 'Korean (한국어)' },
  { id: 'fr', label: 'French (Français)' },
  { id: 'es', label: 'Spanish (Español)' },
  { id: 'de', label: 'German (Deutsch)' },
  { id: 'ru', label: 'Russian (Русский)' },
  { id: 'ar', label: 'Arabic (العربية)' },
  { id: 'hi', label: 'Hindi (हिन्दी)' },
  { id: 'id', label: 'Indonesian (Bahasa Indonesia)' },
  { id: 'ms', label: 'Malay (Bahasa Melayu)' },
  { id: 'pt', label: 'Portuguese (Português)' },
  { id: 'it', label: 'Italian (Italiano)' },
  { id: 'af', label: 'Afrikaans' },
  { id: 'sq', label: 'Albanian' },
  { id: 'am', label: 'Amharic' },
  { id: 'hy', label: 'Armenian' },
  { id: 'as', label: 'Assamese' },
  { id: 'az', label: 'Azerbaijani' },
  { id: 'ba', label: 'Bashkir' },
  { id: 'eu', label: 'Basque' },
  { id: 'be', label: 'Belarusian' },
  { id: 'bn', label: 'Bengali' },
  { id: 'bs', label: 'Bosnian' },
  { id: 'br', label: 'Breton' },
  { id: 'bg', label: 'Bulgarian' },
  { id: 'ca', label: 'Catalan' },
  { id: 'hr', label: 'Croatian' },
  { id: 'cs', label: 'Czech' },
  { id: 'da', label: 'Danish' },
  { id: 'nl', label: 'Dutch' },
  { id: 'et', label: 'Estonian' },
  { id: 'fo', label: 'Faroese' },
  { id: 'fi', label: 'Finnish' },
  { id: 'gl', label: 'Galician' },
  { id: 'ka', label: 'Georgian' },
  { id: 'el', label: 'Greek' },
  { id: 'gu', label: 'Gujarati' },
  { id: 'ht', label: 'Haitian Creole' },
  { id: 'ha', label: 'Hausa' },
  { id: 'haw', label: 'Hawaiian' },
  { id: 'he', label: 'Hebrew' },
  { id: 'hu', label: 'Hungarian' },
  { id: 'is', label: 'Icelandic' },
  { id: 'jw', label: 'Javanese' },
  { id: 'kn', label: 'Kannada' },
  { id: 'kk', label: 'Kazakh' },
  { id: 'la', label: 'Latin' },
  { id: 'lv', label: 'Latvian' },
  { id: 'ln', label: 'Lingala' },
  { id: 'lt', label: 'Lithuanian' },
  { id: 'lb', label: 'Luxembourgish' },
  { id: 'mk', label: 'Macedonian' },
  { id: 'mg', label: 'Malagasy' },
  { id: 'ml', label: 'Malayalam' },
  { id: 'mt', label: 'Maltese' },
  { id: 'mi', label: 'Maori' },
  { id: 'mr', label: 'Marathi' },
  { id: 'mn', label: 'Mongolian' },
  { id: 'ne', label: 'Nepali' },
  { id: 'no', label: 'Norwegian' },
  { id: 'nn', label: 'Norwegian Nynorsk' },
  { id: 'oc', label: 'Occitan' },
  { id: 'ps', label: 'Pashto' },
  { id: 'fa', label: 'Persian' },
  { id: 'pl', label: 'Polish' },
  { id: 'pa', label: 'Punjabi' },
  { id: 'ro', label: 'Romanian' },
  { id: 'sa', label: 'Sanskrit' },
  { id: 'sr', label: 'Serbian' },
  { id: 'sn', label: 'Shona' },
  { id: 'sd', label: 'Sindhi' },
  { id: 'si', label: 'Sinhala' },
  { id: 'sk', label: 'Slovak' },
  { id: 'sl', label: 'Slovenian' },
  { id: 'so', label: 'Somali' },
  { id: 'su', label: 'Sundanese' },
  { id: 'sw', label: 'Swahili' },
  { id: 'sv', label: 'Swedish' },
  { id: 'tl', label: 'Tagalog' },
  { id: 'tg', label: 'Tajik' },
  { id: 'ta', label: 'Tamil' },
  { id: 'tt', label: 'Tatar' },
  { id: 'te', label: 'Telugu' },
  { id: 'bo', label: 'Tibetan' },
  { id: 'tr', label: 'Turkish' },
  { id: 'tk', label: 'Turkmen' },
  { id: 'uk', label: 'Ukrainian' },
  { id: 'ur', label: 'Urdu' },
  { id: 'uz', label: 'Uzbek' },
  { id: 'cy', label: 'Welsh' },
  { id: 'yi', label: 'Yiddish' },
  { id: 'yo', label: 'Yoruba' },
]);

/**
 * Maps ISO-639-1 / locale aliases to canonical NLLB-200 FLORES-200 tags (mirrors `media/languages.py`).
 */
export const ISO_TO_NLLB = Object.freeze({
  af: 'afr_Latn', am: 'amh_Ethi', ar: 'arb_Arab', as: 'asm_Beng', az: 'azj_Latn',
  ba: 'bak_Cyrl', be: 'bel_Cyrl', bg: 'bul_Cyrl', bn: 'ben_Beng', bo: 'bod_Tibt',
  bs: 'bos_Latn', ca: 'cat_Latn', cs: 'ces_Latn', cy: 'cym_Latn', da: 'dan_Latn',
  de: 'deu_Latn', el: 'ell_Grek', en: 'eng_Latn', eo: 'epo_Latn', es: 'spa_Latn',
  et: 'est_Latn', eu: 'eus_Latn', fa: 'pes_Arab', fi: 'fin_Latn', fil: 'tgl_Latn',
  fo: 'fao_Latn', fr: 'fra_Latn', ga: 'gle_Latn', gd: 'gla_Latn', gl: 'glg_Latn',
  gn: 'grn_Latn', gu: 'guj_Gujr', ha: 'hau_Latn', he: 'heb_Hebr', hi: 'hin_Deva',
  hr: 'hrv_Latn', ht: 'hat_Latn', hu: 'hun_Latn', hy: 'hye_Armn', id: 'ind_Latn',
  ig: 'ibo_Latn', in: 'ind_Latn', is: 'isl_Latn', it: 'ita_Latn', iw: 'heb_Hebr',
  ja: 'jpn_Jpan', jv: 'jav_Latn', jw: 'jav_Latn', ka: 'kat_Geor', kk: 'kaz_Cyrl',
  km: 'khm_Khmr', kn: 'kan_Knda', ko: 'kor_Hang', ku: 'kmr_Latn', ky: 'kir_Cyrl',
  lb: 'ltz_Latn', lg: 'lug_Latn', ln: 'lin_Latn', lo: 'lao_Laoo', lt: 'lit_Latn',
  lv: 'lvs_Latn', mg: 'plt_Latn', mi: 'mri_Latn', mk: 'mkd_Cyrl', ml: 'mal_Mlym',
  mn: 'khk_Cyrl', mr: 'mar_Deva', ms: 'zsm_Latn', mt: 'mlt_Latn', my: 'mya_Mymr',
  nb: 'nob_Latn', ne: 'npi_Deva', nl: 'nld_Latn', nn: 'nno_Latn', no: 'nob_Latn',
  ny: 'nya_Latn', oc: 'oci_Latn', om: 'gaz_Latn', or: 'ory_Orya', pa: 'pan_Guru',
  pl: 'pol_Latn', ps: 'pbt_Arab', pt: 'por_Latn', qu: 'quy_Latn', ro: 'ron_Latn',
  ru: 'rus_Cyrl', rw: 'kin_Latn', sa: 'san_Deva', sd: 'snd_Arab', si: 'sin_Sinh',
  sk: 'slk_Latn', sl: 'slv_Latn', sm: 'smo_Latn', sn: 'sna_Latn', so: 'som_Latn',
  sq: 'als_Latn', sr: 'srp_Cyrl', st: 'sot_Latn', su: 'sun_Latn', sv: 'swe_Latn',
  sw: 'swh_Latn', ta: 'tam_Taml', te: 'tel_Telu', tg: 'tgk_Cyrl', th: 'tha_Thai',
  ti: 'tir_Ethi', tk: 'tuk_Latn', tl: 'tgl_Latn', tn: 'tsn_Latn', tr: 'tur_Latn',
  ts: 'tso_Latn', tt: 'tat_Cyrl', tw: 'twi_Latn', ug: 'uig_Arab', uk: 'ukr_Cyrl',
  ur: 'urd_Arab', uz: 'uzn_Latn', vi: 'vie_Latn', wo: 'wol_Latn', xh: 'xho_Latn',
  yi: 'ydd_Hebr', yo: 'yor_Latn', yue: 'yue_Hant', zh: 'zho_Hans',
  'zh-cn': 'zho_Hans', 'zh-hans': 'zho_Hans', 'zh-hant': 'zho_Hant',
  'zh-hk': 'zho_Hant', 'zh-sg': 'zho_Hans', 'zh-tw': 'zho_Hant', zu: 'zul_Latn',
});

// [nllbCode, displayLabel, shortLabel, bcp47] — all 202 FLORES-200 tags in `facebook/nllb-200-distilled-600M`.
const RAW_TARGET_ENTRIES = Object.freeze([
  ['khm_Khmr', 'Khmer (ខ្មែរ)', 'Khmer', 'km'],
  ['eng_Latn', 'English', 'English', 'en'],
  ['zho_Hans', 'Chinese — Simplified (简体中文)', 'Chinese (Simplified)', 'zh-Hans'],
  ['zho_Hant', 'Chinese — Traditional (繁體中文)', 'Chinese (Traditional)', 'zh-Hant'],
  ['yue_Hant', 'Cantonese (粵語)', 'Cantonese', 'yue'],
  ['tha_Thai', 'Thai (ไทย)', 'Thai', 'th'],
  ['vie_Latn', 'Vietnamese (Tiếng Việt)', 'Vietnamese', 'vi'],
  ['lao_Laoo', 'Lao (ລາວ)', 'Lao', 'lo'],
  ['mya_Mymr', 'Burmese / Myanmar (မြန်မာ)', 'Burmese', 'my'],
  ['jpn_Jpan', 'Japanese (日本語)', 'Japanese', 'ja'],
  ['kor_Hang', 'Korean (한국어)', 'Korean', 'ko'],
  ['fra_Latn', 'French (Français)', 'French', 'fr'],
  ['spa_Latn', 'Spanish (Español)', 'Spanish', 'es'],
  ['deu_Latn', 'German (Deutsch)', 'German', 'de'],
  ['rus_Cyrl', 'Russian (Русский)', 'Russian', 'ru'],
  ['arb_Arab', 'Arabic — Modern Standard (العربية)', 'Arabic', 'ar'],
  ['hin_Deva', 'Hindi (हिन्दी)', 'Hindi', 'hi'],
  ['ind_Latn', 'Indonesian (Bahasa Indonesia)', 'Indonesian', 'id'],
  ['zsm_Latn', 'Malay (Bahasa Melayu)', 'Malay', 'ms'],
  ['por_Latn', 'Portuguese (Português)', 'Portuguese', 'pt'],
  ['ita_Latn', 'Italian (Italiano)', 'Italian', 'it'],
  ['ace_Arab', 'Acehnese (Arabic script)', 'Acehnese (Arabic)', 'ace-Arab'],
  ['ace_Latn', 'Acehnese (Latin script)', 'Acehnese', 'ace'],
  ['afr_Latn', 'Afrikaans', 'Afrikaans', 'af'],
  ['aka_Latn', 'Akan', 'Akan', 'ak'],
  ['als_Latn', 'Albanian (Tosk)', 'Albanian', 'sq'],
  ['amh_Ethi', 'Amharic', 'Amharic', 'am'],
  ['arz_Arab', 'Arabic — Egyptian', 'Egyptian Arabic', 'arz'],
  ['acm_Arab', 'Arabic — Mesopotamian', 'Mesopotamian Arabic', 'acm'],
  ['ary_Arab', 'Arabic — Moroccan', 'Moroccan Arabic', 'ary'],
  ['ars_Arab', 'Arabic — Najdi', 'Najdi Arabic', 'ars'],
  ['apc_Arab', 'Arabic — North Levantine', 'North Levantine Arabic', 'apc'],
  ['ajp_Arab', 'Arabic — South Levantine', 'South Levantine Arabic', 'ajp'],
  ['acq_Arab', 'Arabic — Ta’izzi-Adeni', 'Ta’izzi-Adeni Arabic', 'acq'],
  ['aeb_Arab', 'Arabic — Tunisian', 'Tunisian Arabic', 'aeb'],
  ['hye_Armn', 'Armenian', 'Armenian', 'hy'],
  ['asm_Beng', 'Assamese', 'Assamese', 'as'],
  ['ast_Latn', 'Asturian', 'Asturian', 'ast'],
  ['awa_Deva', 'Awadhi', 'Awadhi', 'awa'],
  ['ayr_Latn', 'Aymara (Central)', 'Aymara', 'ay'],
  ['azj_Latn', 'Azerbaijani (North)', 'Azerbaijani', 'az'],
  ['azb_Arab', 'Azerbaijani (South)', 'South Azerbaijani', 'azb'],
  ['bak_Cyrl', 'Bashkir', 'Bashkir', 'ba'],
  ['bam_Latn', 'Bambara', 'Bambara', 'bm'],
  ['ban_Latn', 'Balinese', 'Balinese', 'ban'],
  ['bjn_Arab', 'Banjar (Arabic script)', 'Banjar (Arabic)', 'bjn-Arab'],
  ['bjn_Latn', 'Banjar (Latin script)', 'Banjar', 'bjn'],
  ['eus_Latn', 'Basque', 'Basque', 'eu'],
  ['bel_Cyrl', 'Belarusian', 'Belarusian', 'be'],
  ['bem_Latn', 'Bemba', 'Bemba', 'bem'],
  ['ben_Beng', 'Bengali (বাংলা)', 'Bengali', 'bn'],
  ['bho_Deva', 'Bhojpuri', 'Bhojpuri', 'bho'],
  ['bos_Latn', 'Bosnian', 'Bosnian', 'bs'],
  ['bug_Latn', 'Buginese', 'Buginese', 'bug'],
  ['bul_Cyrl', 'Bulgarian', 'Bulgarian', 'bg'],
  ['cat_Latn', 'Catalan', 'Catalan', 'ca'],
  ['ceb_Latn', 'Cebuano', 'Cebuano', 'ceb'],
  ['tzm_Tfng', 'Central Atlas Tamazight', 'Tamazight', 'tzm'],
  ['ckb_Arab', 'Central Kurdish (Sorani)', 'Sorani Kurdish', 'ckb'],
  ['hne_Deva', 'Chhattisgarhi', 'Chhattisgarhi', 'hne'],
  ['cjk_Latn', 'Chokwe', 'Chokwe', 'cjk'],
  ['crh_Latn', 'Crimean Tatar', 'Crimean Tatar', 'crh'],
  ['hrv_Latn', 'Croatian', 'Croatian', 'hr'],
  ['ces_Latn', 'Czech', 'Czech', 'cs'],
  ['dan_Latn', 'Danish', 'Danish', 'da'],
  ['prs_Arab', 'Dari', 'Dari', 'prs'],
  ['dik_Latn', 'Dinka (Southwestern)', 'Dinka', 'dik'],
  ['nld_Latn', 'Dutch (Nederlands)', 'Dutch', 'nl'],
  ['dyu_Latn', 'Dyula', 'Dyula', 'dyu'],
  ['dzo_Tibt', 'Dzongkha', 'Dzongkha', 'dz'],
  ['epo_Latn', 'Esperanto', 'Esperanto', 'eo'],
  ['est_Latn', 'Estonian', 'Estonian', 'et'],
  ['ewe_Latn', 'Ewe', 'Ewe', 'ee'],
  ['fao_Latn', 'Faroese', 'Faroese', 'fo'],
  ['fij_Latn', 'Fijian', 'Fijian', 'fj'],
  ['fin_Latn', 'Finnish', 'Finnish', 'fi'],
  ['fon_Latn', 'Fon', 'Fon', 'fon'],
  ['fur_Latn', 'Friulian', 'Friulian', 'fur'],
  ['fuv_Latn', 'Fulfulde (Nigerian)', 'Fulfulde', 'fuv'],
  ['glg_Latn', 'Galician', 'Galician', 'gl'],
  ['lug_Latn', 'Ganda', 'Ganda', 'lg'],
  ['kat_Geor', 'Georgian', 'Georgian', 'ka'],
  ['ell_Grek', 'Greek (Ελληνικά)', 'Greek', 'el'],
  ['grn_Latn', 'Guarani', 'Guarani', 'gn'],
  ['guj_Gujr', 'Gujarati', 'Gujarati', 'gu'],
  ['hat_Latn', 'Haitian Creole', 'Haitian Creole', 'ht'],
  ['hau_Latn', 'Hausa', 'Hausa', 'ha'],
  ['heb_Hebr', 'Hebrew (עברית)', 'Hebrew', 'he'],
  ['hun_Latn', 'Hungarian', 'Hungarian', 'hu'],
  ['isl_Latn', 'Icelandic', 'Icelandic', 'is'],
  ['ibo_Latn', 'Igbo', 'Igbo', 'ig'],
  ['ilo_Latn', 'Ilocano', 'Ilocano', 'ilo'],
  ['gle_Latn', 'Irish', 'Irish', 'ga'],
  ['jav_Latn', 'Javanese', 'Javanese', 'jv'],
  ['kac_Latn', 'Jingpho', 'Jingpho', 'kac'],
  ['kbp_Latn', 'Kabiyè', 'Kabiyè', 'kbp'],
  ['kea_Latn', 'Kabuverdianu', 'Kabuverdianu', 'kea'],
  ['kab_Latn', 'Kabyle', 'Kabyle', 'kab'],
  ['kam_Latn', 'Kamba', 'Kamba', 'kam'],
  ['kan_Knda', 'Kannada', 'Kannada', 'kn'],
  ['knc_Arab', 'Kanuri (Arabic script)', 'Kanuri (Arabic)', 'knc-Arab'],
  ['knc_Latn', 'Kanuri (Latin script)', 'Kanuri', 'knc'],
  ['kas_Arab', 'Kashmiri (Arabic script)', 'Kashmiri (Arabic)', 'ks-Arab'],
  ['kas_Deva', 'Kashmiri (Devanagari)', 'Kashmiri', 'ks-Deva'],
  ['kaz_Cyrl', 'Kazakh', 'Kazakh', 'kk'],
  ['kik_Latn', 'Kikuyu', 'Kikuyu', 'ki'],
  ['kmb_Latn', 'Kimbundu', 'Kimbundu', 'kmb'],
  ['kin_Latn', 'Kinyarwanda', 'Kinyarwanda', 'rw'],
  ['kon_Latn', 'Kikongo', 'Kikongo', 'kg'],
  ['kir_Cyrl', 'Kyrgyz', 'Kyrgyz', 'ky'],
  ['ltg_Latn', 'Latgalian', 'Latgalian', 'ltg'],
  ['lvs_Latn', 'Latvian', 'Latvian', 'lv'],
  ['lij_Latn', 'Ligurian', 'Ligurian', 'lij'],
  ['lim_Latn', 'Limburgish', 'Limburgish', 'li'],
  ['lin_Latn', 'Lingala', 'Lingala', 'ln'],
  ['lit_Latn', 'Lithuanian', 'Lithuanian', 'lt'],
  ['lmo_Latn', 'Lombard', 'Lombard', 'lmo'],
  ['lua_Latn', 'Luba-Kasai', 'Luba-Kasai', 'lua'],
  ['luo_Latn', 'Luo', 'Luo', 'luo'],
  ['ltz_Latn', 'Luxembourgish', 'Luxembourgish', 'lb'],
  ['mkd_Cyrl', 'Macedonian', 'Macedonian', 'mk'],
  ['mag_Deva', 'Magahi', 'Magahi', 'mag'],
  ['mai_Deva', 'Maithili', 'Maithili', 'mai'],
  ['mal_Mlym', 'Malayalam', 'Malayalam', 'ml'],
  ['mlt_Latn', 'Maltese', 'Maltese', 'mt'],
  ['mni_Beng', 'Manipuri (Meitei)', 'Manipuri', 'mni'],
  ['mri_Latn', 'Maori', 'Maori', 'mi'],
  ['mar_Deva', 'Marathi', 'Marathi', 'mr'],
  ['min_Latn', 'Minangkabau', 'Minangkabau', 'min'],
  ['lus_Latn', 'Mizo', 'Mizo', 'lus'],
  ['khk_Cyrl', 'Mongolian (Halh)', 'Mongolian', 'mn'],
  ['mos_Latn', 'Mossi', 'Mossi', 'mos'],
  ['npi_Deva', 'Nepali', 'Nepali', 'ne'],
  ['kmr_Latn', 'Northern Kurdish (Kurmanji)', 'Northern Kurdish', 'kmr'],
  ['nso_Latn', 'Northern Sotho', 'Northern Sotho', 'nso'],
  ['nob_Latn', 'Norwegian Bokmål', 'Norwegian', 'nb'],
  ['nno_Latn', 'Norwegian Nynorsk', 'Norwegian Nynorsk', 'nn'],
  ['nus_Latn', 'Nuer', 'Nuer', 'nus'],
  ['nya_Latn', 'Nyanja (Chichewa)', 'Nyanja', 'ny'],
  ['oci_Latn', 'Occitan', 'Occitan', 'oc'],
  ['ory_Orya', 'Odia', 'Odia', 'or'],
  ['pag_Latn', 'Pangasinan', 'Pangasinan', 'pag'],
  ['pap_Latn', 'Papiamento', 'Papiamento', 'pap'],
  ['pbt_Arab', 'Pashto (Southern)', 'Pashto', 'ps'],
  ['pes_Arab', 'Persian / Farsi (فارسی)', 'Persian', 'fa'],
  ['plt_Latn', 'Plateau Malagasy', 'Malagasy', 'mg'],
  ['pol_Latn', 'Polish (Polski)', 'Polish', 'pl'],
  ['pan_Guru', 'Punjabi (Eastern)', 'Punjabi', 'pa'],
  ['quy_Latn', 'Quechua (Ayacucho)', 'Quechua', 'qu'],
  ['ron_Latn', 'Romanian', 'Romanian', 'ro'],
  ['run_Latn', 'Rundi', 'Rundi', 'rn'],
  ['smo_Latn', 'Samoan', 'Samoan', 'sm'],
  ['sag_Latn', 'Sango', 'Sango', 'sg'],
  ['san_Deva', 'Sanskrit', 'Sanskrit', 'sa'],
  ['sat_Beng', 'Santali', 'Santali', 'sat'],
  ['srd_Latn', 'Sardinian', 'Sardinian', 'sc'],
  ['gla_Latn', 'Scottish Gaelic', 'Scottish Gaelic', 'gd'],
  ['srp_Cyrl', 'Serbian', 'Serbian', 'sr'],
  ['shn_Mymr', 'Shan', 'Shan', 'shn'],
  ['sna_Latn', 'Shona', 'Shona', 'sn'],
  ['scn_Latn', 'Sicilian', 'Sicilian', 'scn'],
  ['szl_Latn', 'Silesian', 'Silesian', 'szl'],
  ['snd_Arab', 'Sindhi', 'Sindhi', 'sd'],
  ['sin_Sinh', 'Sinhala', 'Sinhala', 'si'],
  ['slk_Latn', 'Slovak', 'Slovak', 'sk'],
  ['slv_Latn', 'Slovenian', 'Slovenian', 'sl'],
  ['som_Latn', 'Somali', 'Somali', 'so'],
  ['sot_Latn', 'Southern Sotho', 'Southern Sotho', 'st'],
  ['sun_Latn', 'Sundanese', 'Sundanese', 'su'],
  ['swh_Latn', 'Swahili', 'Swahili', 'sw'],
  ['ssw_Latn', 'Swati', 'Swati', 'ss'],
  ['swe_Latn', 'Swedish (Svenska)', 'Swedish', 'sv'],
  ['tgl_Latn', 'Tagalog / Filipino', 'Tagalog', 'tl'],
  ['tgk_Cyrl', 'Tajik', 'Tajik', 'tg'],
  ['taq_Latn', 'Tamasheq (Latin script)', 'Tamasheq', 'taq'],
  ['taq_Tfng', 'Tamasheq (Tifinagh script)', 'Tamasheq (Tifinagh)', 'taq-Tfng'],
  ['tam_Taml', 'Tamil (தமிழ்)', 'Tamil', 'ta'],
  ['tat_Cyrl', 'Tatar', 'Tatar', 'tt'],
  ['tel_Telu', 'Telugu', 'Telugu', 'te'],
  ['bod_Tibt', 'Tibetan', 'Tibetan', 'bo'],
  ['tir_Ethi', 'Tigrinya', 'Tigrinya', 'ti'],
  ['tpi_Latn', 'Tok Pisin', 'Tok Pisin', 'tpi'],
  ['tso_Latn', 'Tsonga', 'Tsonga', 'ts'],
  ['tsn_Latn', 'Tswana', 'Tswana', 'tn'],
  ['tum_Latn', 'Tumbuka', 'Tumbuka', 'tum'],
  ['tur_Latn', 'Turkish (Türkçe)', 'Turkish', 'tr'],
  ['tuk_Latn', 'Turkmen', 'Turkmen', 'tk'],
  ['twi_Latn', 'Twi', 'Twi', 'tw'],
  ['ukr_Cyrl', 'Ukrainian (Українська)', 'Ukrainian', 'uk'],
  ['umb_Latn', 'Umbundu', 'Umbundu', 'umb'],
  ['urd_Arab', 'Urdu (اردو)', 'Urdu', 'ur'],
  ['uig_Arab', 'Uyghur', 'Uyghur', 'ug'],
  ['uzn_Latn', 'Uzbek (Northern)', 'Uzbek', 'uz'],
  ['vec_Latn', 'Venetian', 'Venetian', 'vec'],
  ['war_Latn', 'Waray', 'Waray', 'war'],
  ['cym_Latn', 'Welsh', 'Welsh', 'cy'],
  ['gaz_Latn', 'West Central Oromo', 'Oromo', 'om'],
  ['wol_Latn', 'Wolof', 'Wolof', 'wo'],
  ['xho_Latn', 'Xhosa', 'Xhosa', 'xh'],
  ['ydd_Hebr', 'Yiddish (Eastern)', 'Yiddish', 'yi'],
  ['yor_Latn', 'Yoruba', 'Yoruba', 'yo'],
  ['zul_Latn', 'Zulu', 'Zulu', 'zu'],
]);

/**
 * All 202 NLLB-200 target language options with BCP-47, RTL, and short display metadata.
 */
export const TARGET_LANGUAGE_OPTIONS = Object.freeze(
  RAW_TARGET_ENTRIES.map(([id, label, shortLabel, bcp47]) => Object.freeze({
    id,
    label,
    shortLabel,
    bcp47,
    isRtl: RTL_SCRIPT_SUFFIXES.some(suffix => id.endsWith(suffix)),
    isKhmer: id === DEFAULT_KHMER_TARGET,
  }))
);

const TARGET_BY_ID = new Map(TARGET_LANGUAGE_OPTIONS.map(opt => [opt.id.toLowerCase(), opt]));
const SOURCE_BY_ID = new Map(SOURCE_LANGUAGE_OPTIONS.map(opt => [opt.id.toLowerCase(), opt]));
const BCP47_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const UNDETERMINED_LANGS = new Set(['auto', 'und']);

/**
 * Normalizes any ISO-639-1, locale, or FLORES-200 code into a canonical NLLB-200 target code.
 * @param {string} code - Raw language code (`'km'`, `'en'`, `'jpn_Jpan'`, etc.).
 * @returns {string} Canonical NLLB-200 tag (defaults to `'khm_Khmr'` if unknown).
 */
export function normalizeTargetLanguageCode(code) {
  const cleaned = String(code || '').trim();
  if (!cleaned) return DEFAULT_KHMER_TARGET;
  const lowered = cleaned.toLowerCase();
  if (TARGET_BY_ID.has(lowered)) return TARGET_BY_ID.get(lowered).id;
  const normalized = lowered.replace('_', '-');
  if (ISO_TO_NLLB[normalized]) return ISO_TO_NLLB[normalized];
  const base = normalized.split('-')[0];
  return ISO_TO_NLLB[base] || DEFAULT_KHMER_TARGET;
}

/**
 * Resolves display metadata (`id`, `label`, `shortLabel`, `bcp47`, `isRtl`, `isKhmer`) for a target language.
 * @param {string} code - Target language code.
 * @returns {{ id: string, label: string, shortLabel: string, bcp47: string, isRtl: boolean, isKhmer: boolean }} Target language metadata.
 */
export function resolveTargetLanguageMeta(code) {
  const canonical = normalizeTargetLanguageCode(code);
  return TARGET_BY_ID.get(canonical.toLowerCase()) || TARGET_LANGUAGE_OPTIONS[0];
}

/**
 * Returns true when a Whisper source language code matches a target NLLB-200 language code.
 * Never returns true when `sourceCode` is empty or `'auto'`.
 * @param {string} sourceCode - Source Whisper code or FLORES code.
 * @param {string} targetCode - Target NLLB or ISO code.
 * @returns {boolean} True when both refer to the same NLLB language.
 */
export function isSameSubtitleLanguage(sourceCode, targetCode) {
  const cleanSrc = String(sourceCode || '').trim().toLowerCase();
  const cleanTgt = String(targetCode || '').trim();
  if (!cleanSrc || cleanSrc === 'auto' || !cleanTgt) return false;
  const normalizedSrc = TARGET_BY_ID.get(cleanSrc)?.id || ISO_TO_NLLB[cleanSrc.replace('_', '-')] || ISO_TO_NLLB[cleanSrc.split(/[-_]/)[0]];
  if (!normalizedSrc) return false;
  return normalizedSrc === normalizeTargetLanguageCode(cleanTgt);
}

/**
 * Picks a sensible non-identical default target language when the source language changes.
 * @param {string} sourceCode - Newly selected Whisper source code.
 * @param {string} currentTarget - Currently selected target language code.
 * @returns {string} Canonical NLLB-200 target code different from `sourceCode`.
 */
export function pickDefaultTargetLanguage(sourceCode, currentTarget) {
  const canonicalCurrent = normalizeTargetLanguageCode(currentTarget);
  if (!isSameSubtitleLanguage(sourceCode, canonicalCurrent)) {
    return canonicalCurrent;
  }
  return String(sourceCode || '').trim().toLowerCase() === 'km' ? DEFAULT_ENGLISH_TARGET : DEFAULT_KHMER_TARGET;
}

/**
 * Splits a language option array into `popular` (ordered by `popularIds`) and alphabetical `others`.
 * @param {ReadonlyArray<{ id: string, label: string }>} options - Full language list.
 * @param {ReadonlyArray<string>} popularIds - Ordered popular language IDs.
 * @returns {{ popular: Array<{ id: string, label: string }>, others: Array<{ id: string, label: string }> }} Grouped lists.
 */
export function groupLanguageOptions(options, popularIds) {
  const byId = new Map(options.map(opt => [opt.id, opt]));
  const popularSet = new Set(popularIds);
  const popular = popularIds.map(id => byId.get(id)).filter(Boolean);
  const others = options
    .filter(opt => !popularSet.has(opt.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { popular, others };
}

function formatBcp47Subtags(parts) {
  const head = parts[0].toLowerCase();
  const tail = parts.slice(1).map(tag => {
    if (tag.length === 4 && /^[a-zA-Z]+$/.test(tag)) {
      return tag[0].toUpperCase() + tag.slice(1).toLowerCase();
    }
    if (tag.length === 2 && /^[a-zA-Z]+$/.test(tag)) return tag.toUpperCase();
    return tag.toLowerCase();
  });
  return [head, ...tail].join('-');
}

/**
 * Resolves a Whisper, NLLB-200, or locale tag into a sanitized BCP-47 tag (or `''` when invalid/undetermined).
 * Inputs: `code` language string.
 * Outputs: Sanitized BCP-47 string (`'km'`, `'en-US'`, `'zh-Hans'`, etc.) or `''`.
 * Side effects: none.
 * Failure modes: rejects control characters, whitespace, `'auto'`, `'und'`, and unknown tags with `''`.
 * @param {string} [code=''] - Raw language code.
 * @returns {string} Sanitized BCP-47 tag or empty string.
 */
export function resolveBcp47LanguageTag(code = '') {
  const raw = String(code || '').trim();
  if (!raw || /[\r\n\t\0\s]/.test(raw)) return '';
  const lowered = raw.toLowerCase();
  if (UNDETERMINED_LANGS.has(lowered)) return '';
  const directTarget = TARGET_BY_ID.get(lowered);
  if (directTarget) return directTarget.bcp47;
  const candidate = raw.replace(/_/g, '-');
  if (!BCP47_PATTERN.test(candidate)) return '';
  const parts = candidate.split('-');
  const base = parts[0].toLowerCase();
  if (parts.length === 1) {
    if (ISO_TO_NLLB[base]) return TARGET_BY_ID.get(ISO_TO_NLLB[base].toLowerCase())?.bcp47 || base;
    return SOURCE_BY_ID.has(base) ? base : '';
  }
  const hasKnownBase = Boolean(ISO_TO_NLLB[candidate.toLowerCase()] || ISO_TO_NLLB[base] || SOURCE_BY_ID.has(base));
  return hasKnownBase ? formatBcp47Subtags(parts) : '';
}

/**
 * Resolves a compact human-readable `{ bcp47, label }` summary for export previews and metadata.
 * Inputs: `code` language string.
 * Outputs: `{ bcp47: string, label: string }`.
 * Side effects: none.
 * Failure modes: falls back to `{ bcp47: '', label: 'Undetermined' }` on unknown/empty input.
 * @param {string} [code=''] - Raw language code.
 * @returns {{ bcp47: string, label: string }} Resolved display language metadata.
 */
export function resolveLanguageDisplayMeta(code = '') {
  const bcp47 = resolveBcp47LanguageTag(code);
  if (!bcp47) return { bcp47: '', label: 'Undetermined' };
  const rawLower = String(code || '').trim().toLowerCase();
  const target = TARGET_BY_ID.get(rawLower) || TARGET_BY_ID.get((ISO_TO_NLLB[bcp47.toLowerCase()] || '').toLowerCase());
  if (target) return { bcp47, label: target.shortLabel || target.label };
  const base = bcp47.split('-')[0].toLowerCase();
  const src = SOURCE_BY_ID.get(base);
  if (src) return { bcp47, label: src.label };
  return { bcp47, label: bcp47.toUpperCase() };
}
