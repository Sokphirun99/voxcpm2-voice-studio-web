"""Authoritative offline language catalog bridging all 100 Whisper ASR languages and all 202 NLLB-200 FLORES tags."""

from __future__ import annotations

from typing import Final

# Maps Whisper ISO-639-1 codes (plus common locale aliases) to exact NLLB-200 FLORES-200 tags.
# Note: 97 of 100 Whisper languages have direct NLLB-200 equivalents (`br`, `haw`, `la` do not).
ISO_TO_NLLB: Final[dict[str, str]] = {
    "af": "afr_Latn",
    "am": "amh_Ethi",
    "ar": "arb_Arab",
    "as": "asm_Beng",
    "az": "azj_Latn",
    "ba": "bak_Cyrl",
    "be": "bel_Cyrl",
    "bg": "bul_Cyrl",
    "bn": "ben_Beng",
    "bo": "bod_Tibt",
    "bs": "bos_Latn",
    "ca": "cat_Latn",
    "cs": "ces_Latn",
    "cy": "cym_Latn",
    "da": "dan_Latn",
    "de": "deu_Latn",
    "el": "ell_Grek",
    "en": "eng_Latn",
    "eo": "epo_Latn",
    "es": "spa_Latn",
    "et": "est_Latn",
    "eu": "eus_Latn",
    "fa": "pes_Arab",
    "fi": "fin_Latn",
    "fil": "tgl_Latn",
    "fo": "fao_Latn",
    "fr": "fra_Latn",
    "ga": "gle_Latn",
    "gd": "gla_Latn",
    "gl": "glg_Latn",
    "gn": "grn_Latn",
    "gu": "guj_Gujr",
    "ha": "hau_Latn",
    "he": "heb_Hebr",
    "hi": "hin_Deva",
    "hr": "hrv_Latn",
    "ht": "hat_Latn",
    "hu": "hun_Latn",
    "hy": "hye_Armn",
    "id": "ind_Latn",
    "ig": "ibo_Latn",
    "in": "ind_Latn",
    "is": "isl_Latn",
    "it": "ita_Latn",
    "iw": "heb_Hebr",
    "ja": "jpn_Jpan",
    "jv": "jav_Latn",
    "jw": "jav_Latn",
    "ka": "kat_Geor",
    "kk": "kaz_Cyrl",
    "km": "khm_Khmr",
    "kn": "kan_Knda",
    "ko": "kor_Hang",
    "ku": "kmr_Latn",
    "ky": "kir_Cyrl",
    "lb": "ltz_Latn",
    "lg": "lug_Latn",
    "ln": "lin_Latn",
    "lo": "lao_Laoo",
    "lt": "lit_Latn",
    "lv": "lvs_Latn",
    "mg": "plt_Latn",
    "mi": "mri_Latn",
    "mk": "mkd_Cyrl",
    "ml": "mal_Mlym",
    "mn": "khk_Cyrl",
    "mr": "mar_Deva",
    "ms": "zsm_Latn",
    "mt": "mlt_Latn",
    "my": "mya_Mymr",
    "nb": "nob_Latn",
    "ne": "npi_Deva",
    "nl": "nld_Latn",
    "nn": "nno_Latn",
    "no": "nob_Latn",
    "ny": "nya_Latn",
    "oc": "oci_Latn",
    "om": "gaz_Latn",
    "or": "ory_Orya",
    "pa": "pan_Guru",
    "pl": "pol_Latn",
    "ps": "pbt_Arab",
    "pt": "por_Latn",
    "qu": "quy_Latn",
    "ro": "ron_Latn",
    "ru": "rus_Cyrl",
    "rw": "kin_Latn",
    "sa": "san_Deva",
    "sd": "snd_Arab",
    "si": "sin_Sinh",
    "sk": "slk_Latn",
    "sl": "slv_Latn",
    "sm": "smo_Latn",
    "sn": "sna_Latn",
    "so": "som_Latn",
    "sq": "als_Latn",
    "sr": "srp_Cyrl",
    "st": "sot_Latn",
    "su": "sun_Latn",
    "sv": "swe_Latn",
    "sw": "swh_Latn",
    "ta": "tam_Taml",
    "te": "tel_Telu",
    "tg": "tgk_Cyrl",
    "th": "tha_Thai",
    "ti": "tir_Ethi",
    "tk": "tuk_Latn",
    "tl": "tgl_Latn",
    "tn": "tsn_Latn",
    "tr": "tur_Latn",
    "ts": "tso_Latn",
    "tt": "tat_Cyrl",
    "tw": "twi_Latn",
    "ug": "uig_Arab",
    "uk": "ukr_Cyrl",
    "ur": "urd_Arab",
    "uz": "uzn_Latn",
    "vi": "vie_Latn",
    "wo": "wol_Latn",
    "xh": "xho_Latn",
    "yi": "ydd_Hebr",
    "yo": "yor_Latn",
    "yue": "yue_Hant",
    "zh": "zho_Hans",
    "zh-cn": "zho_Hans",
    "zh-hans": "zho_Hans",
    "zh-hant": "zho_Hant",
    "zh-hk": "zho_Hant",
    "zh-sg": "zho_Hans",
    "zh-tw": "zho_Hant",
    "zu": "zul_Latn",
}

# Exact 202 FLORES-200 target tags shipped by `facebook/nllb-200-distilled-600M`.
SUPPORTED_NLLB_CODES: Final[frozenset[str]] = frozenset({
    "ace_Arab", "ace_Latn", "acm_Arab", "acq_Arab", "aeb_Arab", "afr_Latn", "ajp_Arab", "aka_Latn",
    "als_Latn", "amh_Ethi", "apc_Arab", "arb_Arab", "ars_Arab", "ary_Arab", "arz_Arab", "asm_Beng",
    "ast_Latn", "awa_Deva", "ayr_Latn", "azb_Arab", "azj_Latn", "bak_Cyrl", "bam_Latn", "ban_Latn",
    "bel_Cyrl", "bem_Latn", "ben_Beng", "bho_Deva", "bjn_Arab", "bjn_Latn", "bod_Tibt", "bos_Latn",
    "bug_Latn", "bul_Cyrl", "cat_Latn", "ceb_Latn", "ces_Latn", "cjk_Latn", "ckb_Arab", "crh_Latn",
    "cym_Latn", "dan_Latn", "deu_Latn", "dik_Latn", "dyu_Latn", "dzo_Tibt", "ell_Grek", "eng_Latn",
    "epo_Latn", "est_Latn", "eus_Latn", "ewe_Latn", "fao_Latn", "fij_Latn", "fin_Latn", "fon_Latn",
    "fra_Latn", "fur_Latn", "fuv_Latn", "gaz_Latn", "gla_Latn", "gle_Latn", "glg_Latn", "grn_Latn",
    "guj_Gujr", "hat_Latn", "hau_Latn", "heb_Hebr", "hin_Deva", "hne_Deva", "hrv_Latn", "hun_Latn",
    "hye_Armn", "ibo_Latn", "ilo_Latn", "ind_Latn", "isl_Latn", "ita_Latn", "jav_Latn", "jpn_Jpan",
    "kab_Latn", "kac_Latn", "kam_Latn", "kan_Knda", "kas_Arab", "kas_Deva", "kat_Geor", "kaz_Cyrl",
    "kbp_Latn", "kea_Latn", "khk_Cyrl", "khm_Khmr", "kik_Latn", "kin_Latn", "kir_Cyrl", "kmb_Latn",
    "kmr_Latn", "knc_Arab", "knc_Latn", "kon_Latn", "kor_Hang", "lao_Laoo", "lij_Latn", "lim_Latn",
    "lin_Latn", "lit_Latn", "lmo_Latn", "ltg_Latn", "ltz_Latn", "lua_Latn", "lug_Latn", "luo_Latn",
    "lus_Latn", "lvs_Latn", "mag_Deva", "mai_Deva", "mal_Mlym", "mar_Deva", "min_Latn", "mkd_Cyrl",
    "mlt_Latn", "mni_Beng", "mos_Latn", "mri_Latn", "mya_Mymr", "nld_Latn", "nno_Latn", "nob_Latn",
    "npi_Deva", "nso_Latn", "nus_Latn", "nya_Latn", "oci_Latn", "ory_Orya", "pag_Latn", "pan_Guru",
    "pap_Latn", "pbt_Arab", "pes_Arab", "plt_Latn", "pol_Latn", "por_Latn", "prs_Arab", "quy_Latn",
    "ron_Latn", "run_Latn", "rus_Cyrl", "sag_Latn", "san_Deva", "sat_Beng", "scn_Latn", "shn_Mymr",
    "sin_Sinh", "slk_Latn", "slv_Latn", "smo_Latn", "sna_Latn", "snd_Arab", "som_Latn", "sot_Latn",
    "spa_Latn", "srd_Latn", "srp_Cyrl", "ssw_Latn", "sun_Latn", "swe_Latn", "swh_Latn", "szl_Latn",
    "tam_Taml", "taq_Latn", "taq_Tfng", "tat_Cyrl", "tel_Telu", "tgk_Cyrl", "tgl_Latn", "tha_Thai",
    "tir_Ethi", "tpi_Latn", "tsn_Latn", "tso_Latn", "tuk_Latn", "tum_Latn", "tur_Latn", "twi_Latn",
    "tzm_Tfng", "uig_Arab", "ukr_Cyrl", "umb_Latn", "urd_Arab", "uzn_Latn", "vec_Latn", "vie_Latn",
    "war_Latn", "wol_Latn", "xho_Latn", "ydd_Hebr", "yor_Latn", "yue_Hant", "zho_Hans", "zho_Hant",
    "zsm_Latn", "zul_Latn",
})

_NLLB_LOWER_MAP: Final[dict[str, str]] = {code.lower(): code for code in SUPPORTED_NLLB_CODES}
UNSUPPORTED_WHISPER_TRANSLATION_CODES: Final[frozenset[str]] = frozenset({"br", "haw", "la"})


class UnsupportedLanguageError(ValueError):
    """Raised when a requested subtitle translation language is not supported by NLLB-200."""


def resolve_nllb_lang_code(lang: str, *, strict: bool = False) -> str:
    """Resolve an ISO 639-1/locale code or FLORES-200 tag into a verified NLLB-200 language code."""
    cleaned = (lang or "").strip()
    if not cleaned:
        if strict:
            raise UnsupportedLanguageError("Translation language code is required.")
        return "eng_Latn"
    lowered = cleaned.lower()
    if lowered in _NLLB_LOWER_MAP:
        return _NLLB_LOWER_MAP[lowered]
    normalized_hyphen = lowered.replace("_", "-")
    if normalized_hyphen in ISO_TO_NLLB:
        return ISO_TO_NLLB[normalized_hyphen]
    base_code = normalized_hyphen.split("-", 1)[0]
    if base_code in ISO_TO_NLLB:
        return ISO_TO_NLLB[base_code]
    if strict or base_code in UNSUPPORTED_WHISPER_TRANSLATION_CODES:
        raise UnsupportedLanguageError(
            f"Unsupported translation language '{cleaned}'. Choose one of the {len(SUPPORTED_NLLB_CODES)} NLLB-200 languages."
        )
    return "eng_Latn"


def is_same_translation_language(source_lang: str, target_lang: str) -> bool:
    """Return True when `source_lang` and `target_lang` map to the same NLLB-200 language code."""
    if not (source_lang and source_lang.strip()) or not (target_lang and target_lang.strip()):
        return False
    try:
        return resolve_nllb_lang_code(source_lang, strict=True) == resolve_nllb_lang_code(target_lang, strict=True)
    except UnsupportedLanguageError:
        return source_lang.strip().lower() == target_lang.strip().lower()
