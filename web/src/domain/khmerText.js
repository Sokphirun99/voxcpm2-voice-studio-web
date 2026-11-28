/**
 * @fileoverview Pure domain Khmer Unicode cleanup and spoken number/currency expansion for cleaner TTS synthesis.
 */

import { preservePauseMarkers } from './pauseMarkers.js';

const KHMER_SCRIPT_PATTERN = /[\u1780-\u17FF]/;
const INVISIBLE_JUNK_PATTERN = /[\uFEFF\u00AD\u200C\u200D]/g;
const BROKEN_VOWEL_O_PATTERN = /\u17C1\u17B6/g;
const BROKEN_VOWEL_AE_PATTERN = /\u17C1\u17B8/g;
const MULTI_SPACE_PATTERN = /[ \t\u00A0]+/g;
const SPACE_BEFORE_PUNCT_PATTERN = /[ \t]+([។៕!?៖,.])/g;
const KHMER_DIGIT_ZERO = 0x17e0;

const KHMER_DIGITS = ['សូន្យ', 'មួយ', 'ពីរ', 'បី', 'បួន', 'ប្រាំ', 'ប្រាំមួយ', 'ប្រាំពីរ', 'ប្រាំបី', 'ប្រាំបួន'];
const KHMER_TENS = ['', 'ដប់', 'ម្ភៃ', 'សាមសិប', 'សែសិប', 'ហាសិប', 'ហុកសិប', 'ចិតសិប', 'ប៉ែតសិប', 'កៅសិប'];
const KHMER_MONTHS = Object.freeze([
  '', 'មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា',
  'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ',
]);

/**
 * Normalizes Khmer Unicode sequences, strips invisible paste artifacts, and tidies spacing without altering digits.
 * Inputs: raw text string.
 * Outputs: cleaned NFC string preserving line breaks.
 * Side effects: none.
 * Failure modes: returns empty string for non-string input.
 * @param {unknown} rawText - Candidate script text.
 * @returns {string} Unicode-normalized text.
 */
export function normalizeKhmerUnicode(rawText) {
  if (typeof rawText !== 'string') return '';
  return rawText
    .normalize('NFC')
    .replace(INVISIBLE_JUNK_PATTERN, '')
    .replace(BROKEN_VOWEL_O_PATTERN, '\u17C4')
    .replace(BROKEN_VOWEL_AE_PATTERN, '\u17BE')
    .replace(/\r\n?/g, '\n')
    .replace(MULTI_SPACE_PATTERN, ' ')
    .replace(SPACE_BEFORE_PUNCT_PATTERN, '$1')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim();
}

/**
 * Replaces Khmer digits (`០–៩`) with ASCII digits (`0–9`) for uniform numeric parsing.
 * @param {string} rawDigits - Digit token.
 * @returns {string} ASCII digit string.
 */
function toAsciiDigits(rawDigits) {
  let out = '';
  for (const ch of rawDigits) {
    const code = ch.charCodeAt(0);
    out += code >= KHMER_DIGIT_ZERO && code <= KHMER_DIGIT_ZERO + 9
      ? String(code - KHMER_DIGIT_ZERO)
      : ch;
  }
  return out;
}

/**
 * Converts a non-negative integer below 1,000 into spoken Khmer words.
 * @param {number} n - Integer `0 <= n < 1000`.
 * @returns {string} Spoken Khmer phrase.
 */
function underThousandToKhmer(n) {
  const hundreds = Math.floor(n / 100);
  const rem = n % 100;
  const tens = Math.floor(rem / 10);
  const ones = rem % 10;
  const parts = [];
  if (hundreds > 0) parts.push(`${KHMER_DIGITS[hundreds]}រយ`);
  if (tens > 0) parts.push(KHMER_TENS[tens]);
  if (ones > 0 || parts.length === 0) parts.push(KHMER_DIGITS[ones]);
  return parts.join('');
}

/**
 * Converts a finite non-negative integer string into spoken Khmer words.
 * Inputs: integer value as number or ASCII/Khmer digit string.
 * Outputs: spoken Khmer wording.
 * Side effects: none.
 * Failure modes: returns original token if above supported billion range or invalid.
 * @param {string|number} rawInteger - Integer value.
 * @returns {string} Spoken Khmer words.
 */
export function integerToKhmerWords(rawInteger) {
  const clean = toAsciiDigits(String(rawInteger)).replace(/,/g, '');
  if (!/^\d+$/.test(clean)) return String(rawInteger);
  const value = Number(clean);
  if (!Number.isSafeInteger(value) || value > 999_999_999) return String(rawInteger);
  if (value === 0) return KHMER_DIGITS[0];
  const millions = Math.floor(value / 1_000_000);
  const thousands = Math.floor((value % 1_000_000) / 1_000);
  const rest = value % 1_000;
  const parts = [];
  if (millions > 0) parts.push(`${underThousandToKhmer(millions)}លាន`);
  if (thousands > 0) parts.push(`${underThousandToKhmer(thousands)}ពាន់`);
  if (rest > 0) parts.push(underThousandToKhmer(rest));
  return parts.join('');
}

/**
 * Converts a decimal or integer token into spoken Khmer words.
 * @param {string} token - Numeric token containing ASCII or Khmer digits and optional fractional dot.
 * @returns {string} Spoken Khmer wording.
 */
function numberTokenToKhmer(token) {
  const clean = toAsciiDigits(token).replace(/,/g, '');
  const [intPart, decPart] = clean.split('.');
  const spokenInt = integerToKhmerWords(intPart || '0');
  if (decPart === undefined) return spokenInt;
  const spokenDec = Array.from(decPart).map(d => KHMER_DIGITS[Number(d)] ?? d).join('');
  return `${spokenInt}ចុច${spokenDec}`;
}

/**
 * Formats a `HH:MM` clock token into spoken Khmer hours and minutes.
 * @param {string} match - Matched raw token.
 * @param {string} hoursRaw - Hour digits.
 * @param {string} minutesRaw - Minute digits.
 * @returns {string} Spoken Khmer time phrase or original token when out of range.
 */
function formatTimeTokenToKhmer(match, hoursRaw, minutesRaw) {
  const hours = Number(toAsciiDigits(hoursRaw));
  const minutes = Number(toAsciiDigits(minutesRaw));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return match;
  const minPhrase = minutes === 0 ? 'គត់' : `${integerToKhmerWords(minutes)}នាទី`;
  return `${integerToKhmerWords(hours)}ម៉ោង${minPhrase}`;
}

/**
 * Formats a Celsius or Fahrenheit temperature token into spoken Khmer words.
 * @param {string} numRaw - Numeric token.
 * @param {string} unit - Temperature unit letter (`C` or `F`).
 * @returns {string} Spoken Khmer temperature phrase.
 */
function formatTemperatureTokenToKhmer(numRaw, unit) {
  const label = unit.toUpperCase() === 'C' ? 'អង្សាសេ' : 'អង្សាហ្វារិនហៃ';
  return `${numberTokenToKhmer(numRaw)}${label}`;
}

/**
 * Converts a valid Gregorian date token into Khmer spoken calendar order (day, month, year).
 * Invalid dates are returned unchanged instead of being partially interpreted as numbers.
 * @param {string} _match - Full matched date.
 * @param {string} first - First date component.
 * @param {string} second - Second date component.
 * @param {string} third - Third date component.
 * @param {'dmy'|'ymd'} order - Input component order.
 * @returns {string} Spoken Khmer date or the original date for invalid input.
 */
function formatKhmerCalendarDate(_match, first, second, third, order) {
  const parts = [first, second, third].map(value => Number(toAsciiDigits(value)));
  const [day, month, year] = order === 'dmy'
    ? parts
    : [parts[2], parts[1], parts[0]];
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return _match;
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) return _match;
  return `ថ្ងៃទី${integerToKhmerWords(day)} ខែ${KHMER_MONTHS[month]} ឆ្នាំ${integerToKhmerWords(year)}`;
}

/**
 * Makes uppercase acronym/version boundaries explicit for Khmer speech expansion.
 * Mixed-case product names such as `VoxCPM2` are intentionally left intact.
 * @param {string} text - Normalized Khmer-context text.
 * @returns {string} Text with acronym/version token boundaries.
 */
function separateAcronymVersionDigits(text) {
  return text.replace(/\b([A-Z]{2,})-?(?=[0-9\u17E0-\u17E9])/g, '$1 ');
}

function renderDateMatch(match, first, second, third, order, source, offset) {
  const formatted = formatKhmerCalendarDate(match, first, second, third, order);
  if (formatted === match) return match;
  const prefix = source.slice(Math.max(0, offset - 12), offset);
  return /ថ្ងៃទី\s*$/.test(prefix) ? formatted.replace(/^ថ្ងៃទី/, '') : formatted;
}

/**
 * Expands currency (`$25`, `1500៛`), percentages (`50%`), time (`10:30`), temperature (`37°C`), and numbers into spoken Khmer words when Khmer text is present.
 * Inputs: script text string.
 * Outputs: Unicode-normalized text with Khmer-context numerals/currencies/times spoken out.
 * Side effects: none.
 * Failure modes: returns trimmed string unchanged for non-Khmer scripts without Khmer digits.
 * @param {unknown} rawText - Input script text.
 * @returns {string} Script with spoken Khmer numbers, times, temperatures, and currencies.
 */
export function expandKhmerNumbers(rawText) {
  const text = normalizeKhmerUnicode(rawText);
  if (!text) return '';
  if (!KHMER_SCRIPT_PATTERN.test(text) && !/[\u17E0-\u17E9៛]/.test(text)) return text;
  const numPattern = '[0-9\u17E0-\u17E9]+(?:,[0-9\u17E0-\u17E9]{3})*(?:\\.[0-9\u17E0-\u17E9]+)?';
  const timePattern = '(?<![A-Za-z0-9_:.])([0-2]?[0-9]|[\u17E0-\u17E2]?[\u17E0-\u17E9]):([0-5][0-9]|[\u17E0-\u17E5][\u17E0-\u17E9])(?![A-Za-z0-9_:.])';
  const dateDigits = '[0-9\u17E0-\u17E9]';
  const dmyDatePattern = new RegExp(`(?<![A-Za-z0-9_.])(${dateDigits}{1,2})\\/(${dateDigits}{1,2})\\/(${dateDigits}{4})(?![A-Za-z0-9_.])`, 'g');
  const ymdDatePattern = new RegExp(`(?<![A-Za-z0-9_.])(${dateDigits}{4})-(${dateDigits}{1,2})-(${dateDigits}{1,2})(?![A-Za-z0-9_.])`, 'g');
  const invalidDates = [];
  const renderDate = (match, first, second, third, order, source, offset) => {
    const rendered = renderDateMatch(match, first, second, third, order, source, offset);
    if (rendered !== match) return rendered;
    const placeholder = `INVALIDDATE${invalidDates.length}TOKEN`;
    invalidDates.push([placeholder, match]);
    return placeholder;
  };
  const prepared = separateAcronymVersionDigits(text)
    .replace(dmyDatePattern, (match, day, month, year, offset, source) => renderDate(match, day, month, year, 'dmy', source, offset))
    .replace(ymdDatePattern, (match, year, month, day, offset, source) => renderDate(match, year, month, day, 'ymd', source, offset));
  const expanded = preservePauseMarkers(prepared, masked => masked
    .replace(new RegExp(`(${numPattern})\\s*°\\s*([CFcf])`, 'g'), (_, num, unit) => formatTemperatureTokenToKhmer(num, unit))
    .replace(new RegExp(timePattern, 'g'), formatTimeTokenToKhmer)
    .replace(new RegExp(`\\$\\s*(${numPattern})`, 'g'), (_, num) => `${numberTokenToKhmer(num)}ដុល្លារ`)
    .replace(new RegExp(`(${numPattern})\\s*\\$`, 'g'), (_, num) => `${numberTokenToKhmer(num)}ដុល្លារ`)
    .replace(new RegExp(`(${numPattern})\\s*៛`, 'g'), (_, num) => `${numberTokenToKhmer(num)}រៀល`)
    .replace(new RegExp(`(${numPattern})\\s*%`, 'g'), (_, num) => `${numberTokenToKhmer(num)}ភាគរយ`)
    .replace(new RegExp(`(?<![A-Za-z0-9_.])(${numPattern})(?![A-Za-z0-9_.])`, 'g'), (_, num) => numberTokenToKhmer(num)));
  return invalidDates.reduce((result, [placeholder, original]) => result.replace(placeholder, original), expanded);
}

/**
 * Checks whether a script contains Khmer-context digits or currencies that can be expanded into words.
 * @param {unknown} rawText - Input script text.
 * @returns {boolean} True when expansion would rewrite part of the text.
 */
export function hasConvertibleKhmerNumbers(rawText) {
  const cleaned = normalizeKhmerUnicode(rawText);
  return Boolean(cleaned) && expandKhmerNumbers(cleaned) !== cleaned;
}
