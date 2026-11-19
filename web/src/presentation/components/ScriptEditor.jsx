/**
 * @fileoverview Script editor pane with Khmer sample loader, live grapheme counter, and clear action.
 */

import React from 'react';
import { expandKhmerNumbers, hasConvertibleKhmerNumbers } from '../../domain/khmerText.js';
import { MAX_SCRIPT_LENGTH } from '../../domain/presets.js';
import { Icon } from './Icon.jsx';

const KHMER_EXAMPLE = 'សួស្តីអ្នកទាំងអស់គ្នា។ ថ្ងៃនេះយើងនឹងសាកល្បងបម្លែងអត្ថបទជាភាសាខ្មែរទៅជាសំឡេងដោយប្រើតួអង្គតែមួយគត់។';

/**
 * Renders the text script input area, Khmer sample button, number-word helper, character counter, and clear button.
 * Inputs: `{ scriptInput, script, count, isOverLimit, onReplaceScript, onScriptChange, onScriptKey }`.
 * Outputs: `<section className="editor">` element.
 * Side effects: updates controlled script state and focuses textarea on example/clear/format actions.
 * Failure modes: none.
 * @param {object} props - Script editor props.
 * @returns {React.ReactElement} Script editor section.
 */
export function ScriptEditor({ scriptInput, script, count, isOverLimit, onReplaceScript, onScriptChange, onScriptKey }) {
  const canFormatNumbers = hasConvertibleKhmerNumbers(script);
  return (
    <section className="editor" aria-labelledby="editor-title">
      <div className="pane-heading">
        <h2 id="editor-title"><label htmlFor="script">Script</label></h2>
        <div className="editor-heading-actions">
          {canFormatNumbers && (
            <button type="button" className="button subtle-button" id="format-khmer-numbers"
              onClick={() => onReplaceScript(expandKhmerNumbers(script))}>
              Speak numbers in Khmer
            </button>
          )}
          <button type="button" className="button subtle-button" id="khmer-example"
            onClick={() => onReplaceScript(KHMER_EXAMPLE)}>
            <Icon name="text_quote" />Khmer example
          </button>
        </div>
      </div>
      <textarea id="script" ref={scriptInput} aria-describedby="character-count"
        placeholder="Write or paste the text you want to hear…" spellCheck={false} required
        value={script} onChange={event => onScriptChange(event.target.value)} onKeyDown={onScriptKey} />
      <div className="editor-footer">
        <span id="character-count" className={isOverLimit ? 'is-limit' : undefined}>
          {count.toLocaleString()} / {MAX_SCRIPT_LENGTH.toLocaleString()} {count === 1 ? 'character' : 'characters'}
        </span>
        <button type="button" className="button subtle-button clear-button" id="clear-script"
          disabled={!script} onClick={() => onReplaceScript('')}>Clear</button>
      </div>
    </section>
  );
}
