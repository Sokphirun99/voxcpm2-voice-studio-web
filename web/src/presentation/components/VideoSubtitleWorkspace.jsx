/**
 * @fileoverview Self-contained Function 2 workspace: Multi-language Video -> Subtitle Extractor, Editor, Translator, and Burn-in Studio.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Blocks } from 'loading-dev';
import {
  POPULAR_SOURCE_LANGUAGE_IDS,
  POPULAR_TARGET_LANGUAGE_IDS,
  SOURCE_LANGUAGE_OPTIONS,
  SUBTITLE_BACKGROUND_OPTIONS,
  SUBTITLE_FONT_SCALE_OPTIONS,
  SUBTITLE_POSITION_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
  getSpeakerColor,
  groupLanguageOptions,
  isSameSubtitleLanguage,
  resolveModelReadinessHints,
  resolveSpeakerLabel,
} from '../../domain/subtitles.js';
import { createSubtitleProjectSnapshot } from '../../domain/projects.js';
import { useSubtitleVoiceover } from '../hooks/useSubtitleVoiceover.js';
import { useVideoSubtitles } from '../hooks/useVideoSubtitles.js';
import { Icon } from './Icon.jsx';
import { DraftRecoveryBanner } from './DraftRecoveryBanner.jsx';
import { MissingAssetBanner } from './MissingAssetBanner.jsx';
import { OfflineReadinessBadge } from './OfflineReadinessBadge.jsx';
import { ProjectAutosaveBadge } from './ProjectAutosaveBadge.jsx';
import { SubtitleExportDock } from './SubtitleExportDock.jsx';
import { SubtitleSegmentRow } from './SubtitleSegmentRow.jsx';
import { SubtitleVoiceOutputCard, SubtitleVoiceToolbar } from './SubtitleVoiceControls.jsx';

const GENERATE_SPINNER_SIZE_PX = 16;

const SPEAKER_COUNT_OPTIONS = Object.freeze([
  { id: '0', label: 'Auto-detect speakers' },
  { id: '2', label: '2 speakers (Dialogue)' },
  { id: '3', label: '3 speakers' },
  { id: '4', label: '4 speakers' },
  { id: '6', label: '5+ speakers' },
]);

function SubtitleToolbar({ busy, extracting, relinking, hasFile, hasSegments, onClear, onCancel, onExtract, autosave, offlineReadiness, onSelectModels }) {
  return (
    <header className="studio-toolbar">
      <div className="toolbar-heading-group">
        <h1>Video to subtitle</h1>
        {autosave && <ProjectAutosaveBadge autosave={autosave} />}
        {offlineReadiness && <OfflineReadinessBadge readiness={offlineReadiness} onSelect={onSelectModels} />}
      </div>
      <div className="toolbar-actions">
        {!busy && (
          <button type="button" id="subtitle-clear-btn" className="button subtle-button cancel-button"
            disabled={!hasFile && !hasSegments} onClick={onClear}>Clear</button>
        )}
        {busy && (
          <button type="button" id="subtitle-cancel-btn" className="button subtle-button cancel-button" onClick={onCancel}>
            <Icon name="stop_fill" /><span>Cancel</span>
          </button>
        )}
        <button type="button" id="subtitle-extract-btn" className={extracting ? 'button generate is-generating' : 'button generate'}
          disabled={!hasFile || busy} aria-busy={extracting || undefined} onClick={onExtract}>
          {extracting ? <Blocks size={GENERATE_SPINNER_SIZE_PX} className="generate-spinner" /> : <Icon name="subtitles" />}
          <span>{extracting ? (relinking ? 'Linking…' : 'Extracting…') : relinking ? 'Link video for burn-in' : 'Extract subtitles'}</span>
        </button>
      </div>
    </header>
  );
}

function MediaOfflineBanner({ health, onRefresh }) {
  if (!health.checked || health.online) return null;
  return (
    <div className="engine-alert-popup" role="alert">
      <span className="engine-alert-dot" aria-hidden="true" />
      <div className="engine-alert-body">
        <strong>Video subtitle service offline</strong>
        <span>{health.reason || 'Local Whisper / Diarization server is not reachable on port 8810.'}</span>
      </div>
      <div className="engine-alert-actions">
        <button type="button" className="button engine-retry-button" onClick={onRefresh}>Refresh</button>
      </div>
    </div>
  );
}

function VideoPreviewCard({ ctrl, busy = false, onSelectFile, onImportSubtitle }) {
  const { videoRef, vttUrl, useTranslation, bilingual, translatedLanguageMeta, handleVideoMetadata, handleVideoTimeUpdate } = ctrl;
  const { videoFile, videoFileName, videoUrl, videoSize, isAudioOnly, detectedLanguage } = ctrl.state;
  const trackRef = useRef(null);
  const subtitleFileInputRef = useRef(null);
  const isPortrait = Boolean(videoSize && videoSize.height > videoSize.width);
  const aspectStyle = videoSize ? { '--video-aspect': `${videoSize.width} / ${videoSize.height}` } : undefined;
  const targetShort = translatedLanguageMeta?.shortLabel || 'Khmer';
  const trackLabel = bilingual ? `Original + ${targetShort}` : useTranslation ? targetShort : 'Original';
  const trackLang = useTranslation ? (translatedLanguageMeta?.bcp47 || 'km') : (detectedLanguage || 'en');

  const showTrack = () => {
    const trackEl = trackRef.current;
    if (trackEl?.track) trackEl.track.mode = 'showing';
  };

  useEffect(() => {
    if (vttUrl) showTrack();
  }, [vttUrl, trackLabel]);

  return (
    <section className="subtitle-video-card" aria-label="Video preview">
      {videoUrl ? (
        <div
          className="subtitle-video-frame"
          data-orientation={isPortrait ? 'portrait' : 'landscape'}
          data-media-kind={isAudioOnly ? 'audio' : 'video'}
          style={aspectStyle}
        >
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            playsInline
            className="subtitle-video-player"
            onLoadedMetadata={e => { handleVideoMetadata?.(e.currentTarget); showTrack(); }}
            onTimeUpdate={e => handleVideoTimeUpdate?.(e.currentTarget.currentTime)}
          >
            {vttUrl && (
              <track
                ref={trackRef}
                kind="subtitles"
                src={vttUrl}
                srcLang={trackLang}
                label={trackLabel}
                default
                onLoad={showTrack}
              />
            )}
          </video>
        </div>
      ) : null}
      <label className="subtitle-upload-dropzone" htmlFor="subtitle-video-input">
        <input id="subtitle-video-input" type="file" accept="video/*,audio/*,.mkv,.avi,.m4v,.aac,.ogg,.flac"
          disabled={busy} onChange={e => { onSelectFile(e.target.files?.[0]); e.target.value = ''; }} />
        <Icon name="upload" />
        <span className="subtitle-upload-copy">
          <strong>{videoFile?.name || (videoFileName ? `Re-link ${videoFileName}` : 'Choose a video or audio clip')}</strong>
          <span>{videoFile || videoFileName ? 'Click to replace or re-link file (.mp4, .mov, .mkv, .webm, .mp3, .wav)' : 'Movies, news, podcasts, or audio clips (max 500 MB)'}</span>
        </span>
      </label>
      <div className="subtitle-file-import">
        <input
          ref={subtitleFileInputRef}
          id="subtitle-file-input"
          type="file"
          accept=".srt,.vtt,text/vtt,application/x-subrip"
          hidden
          disabled={busy}
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) void onImportSubtitle?.(file);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="button subtle-button subtitle-file-import-button"
          disabled={busy}
          onClick={() => subtitleFileInputRef.current?.click()}
        >
          Import .srt / .vtt
        </button>
      </div>
    </section>
  );
}

function SpeakerRosterCard({ speakers, speakerNames, includeSpeaker, busy, onRename }) {
  const showRoster = speakers.length > 1 || (speakers.length === 1 && includeSpeaker);
  if (!showRoster) return null;
  return (
    <div className="subtitle-roster">
      <span className="field-label">{speakers.length === 1 ? 'Speaker (1)' : `Speakers (${speakers.length})`}</span>
      <div className="subtitle-roster-list">
        {speakers.map(id => (
          <label key={id} className="subtitle-roster-chip" style={{ '--spk-color': getSpeakerColor(id) }}>
            <span className="subtitle-speaker-dot" aria-hidden="true" />
            <input type="text" className="subtitle-roster-input" disabled={busy}
              aria-label={`Rename ${id}`} placeholder={resolveSpeakerLabel(id)}
              value={speakerNames[id] || ''} onChange={e => onRename(id, e.target.value)} />
          </label>
        ))}
      </div>
    </div>
  );
}

function BurnStyleControls({ subtitleStyle, busy, onChangeStyle }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="subtitle-style-section">
      <button type="button" className="advanced-button" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span>Burn-in subtitle style</span>
        <Icon name="chevron_down" />
      </button>
      <div className="subtitle-style-grid" hidden={!open}>
        <label className="field-compact">
          <span className="field-label">Position</span>
          <div className="select-field select-field--plain">
            <select id="subtitle-style-position" value={subtitleStyle.position} disabled={busy}
              onChange={e => onChangeStyle('position', e.target.value)}>
              {SUBTITLE_POSITION_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </label>
        <label className="field-compact">
          <span className="field-label">Text size</span>
          <div className="select-field select-field--plain">
            <select id="subtitle-style-scale" value={subtitleStyle.fontScale} disabled={busy}
              onChange={e => onChangeStyle('fontScale', e.target.value)}>
              {SUBTITLE_FONT_SCALE_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </label>
        <label className="field-compact">
          <span className="field-label">Background</span>
          <div className="select-field select-field--plain">
            <select id="subtitle-style-bg" value={subtitleStyle.backgroundStyle} disabled={busy}
              onChange={e => onChangeStyle('backgroundStyle', e.target.value)}>
              {SUBTITLE_BACKGROUND_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </label>
      </div>
    </div>
  );
}

function SubtitleToggleRow({ id, label, checked, disabled, hidden = false, onChange }) {
  const labelId = `${id}-label`;
  return (
    <div className="subtitle-toggle-row" hidden={hidden} data-disabled={disabled ? 'true' : undefined}>
      <span id={labelId} className="subtitle-toggle-label">{label}</span>
      <input
        id={id}
        className="subtitle-switch"
        type="checkbox"
        role="switch"
        aria-labelledby={labelId}
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
    </div>
  );
}

const GROUPED_SOURCE_LANGUAGES = groupLanguageOptions(SOURCE_LANGUAGE_OPTIONS, POPULAR_SOURCE_LANGUAGE_IDS);
const GROUPED_TARGET_LANGUAGES = groupLanguageOptions(TARGET_LANGUAGE_OPTIONS, POPULAR_TARGET_LANGUAGE_IDS);

function GroupedLanguageOptions({ grouped }) {
  return (
    <>
      <optgroup label="Popular">
        {grouped.popular.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
      </optgroup>
      <optgroup label="All languages (A–Z)">
        {grouped.others.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
      </optgroup>
    </>
  );
}

function SubtitleSettingsForm({ ctrl, modelHints = [] }) {
  const { options, segments, busyAction, videoFile, isAudioOnly, translatedLanguage } = ctrl.state;
  const busy = Boolean(busyAction);
  const hasTranslation = Boolean(ctrl.hasTranslation);
  const canTranslate = ctrl.canTranslate !== false;
  const targetMeta = ctrl.targetLanguageMeta || { shortLabel: 'Khmer' };
  const translatedMeta = ctrl.translatedLanguageMeta || targetMeta;
  const isRetranslatingSameTarget = hasTranslation && isSameSubtitleLanguage(translatedLanguage, options.targetLanguage);
  const showSpeakerLabelToggle = options.detectSpeakers || ctrl.speakers.length > 1;
  const showTargetSelector = Boolean(options.translateToKhmer) || segments.length > 0;
  const showKhmerDoubleCheck = options.sourceLanguage === 'km' || options.sourceLanguage === 'auto';
  return (
    <div className="subtitle-settings-stack">
      <div className="subtitle-option-grid" data-columns={options.detectSpeakers ? '2' : '1'}>
        <div className="field field-compact">
          <label className="field-label" htmlFor="subtitle-source-lang">Video language</label>
          <div className="select-field select-field--plain">
            <select id="subtitle-source-lang" value={options.sourceLanguage} disabled={busy}
              onChange={e => ctrl.updateOption('sourceLanguage', e.target.value)}>
              <GroupedLanguageOptions grouped={GROUPED_SOURCE_LANGUAGES} />
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </div>
        <div className="field field-compact" hidden={!options.detectSpeakers}>
          <label className="field-label" htmlFor="subtitle-speaker-count">Speakers</label>
          <div className="select-field select-field--plain">
            <select id="subtitle-speaker-count" value={options.speakerCount} disabled={busy}
              onChange={e => ctrl.updateOption('speakerCount', e.target.value)}>
              {SPEAKER_COUNT_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </div>
      </div>
      <div className="field-row-toggles">
        <SubtitleToggleRow
          id="subtitle-detect-speakers"
          label="Detect speakers"
          checked={options.detectSpeakers}
          disabled={busy}
          onChange={checked => ctrl.updateOption('detectSpeakers', checked)}
        />
        <SubtitleToggleRow
          id="subtitle-double-check-khmer"
          label="Double-check Khmer (Whisper)"
          checked={Boolean(options.doubleCheckKhmer)}
          disabled={busy}
          hidden={!showKhmerDoubleCheck}
          onChange={checked => ctrl.updateOption('doubleCheckKhmer', checked)}
        />
        <SubtitleToggleRow
          id="subtitle-auto-translate"
          label="Translate subtitles"
          checked={options.translateToKhmer}
          disabled={busy}
          onChange={checked => ctrl.updateOption('translateToKhmer', checked)}
        />
        <SubtitleToggleRow
          id="subtitle-include-speaker"
          label="Show speaker names"
          checked={options.includeSpeaker}
          disabled={busy}
          hidden={!showSpeakerLabelToggle}
          onChange={checked => ctrl.updateOption('includeSpeaker', checked)}
        />
      </div>
      {modelHints.length > 0 && (
        <div className="subtitle-model-hints" aria-label="First-time model downloads">
          {modelHints.map(hint => <p key={hint}>{hint}</p>)}
        </div>
      )}
      {showTargetSelector && (
        <div className="field field-compact">
          <label className="field-label" htmlFor="subtitle-target-lang">Translate to</label>
          <div className="select-field select-field--plain">
            <select id="subtitle-target-lang" value={options.targetLanguage} disabled={busy}
              onChange={e => ctrl.updateOption('targetLanguage', e.target.value)}>
              <GroupedLanguageOptions grouped={GROUPED_TARGET_LANGUAGES} />
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </div>
      )}
      {segments.length > 0 && (
        <div className="subtitle-translate-bar">
          <button
            type="button"
            id="subtitle-translate-btn"
            className="button button-secondary"
            disabled={busy || !canTranslate}
            title={!canTranslate ? 'Choose a target language different from the source language.' : undefined}
            onClick={() => void ctrl.translateNow()}
          >
            {busyAction === 'translate'
              ? 'Translating…'
              : isRetranslatingSameTarget
                ? `Re-translate ${targetMeta.shortLabel}`
                : `Translate to ${targetMeta.shortLabel}`}
          </button>
          {hasTranslation && (
            <div className="select-field select-field--plain">
              <select aria-label="Preview language" value={options.previewMode} disabled={busy}
                onChange={e => ctrl.updateOption('previewMode', e.target.value)}>
                <option value="translated">{translatedMeta.shortLabel} subtitles</option>
                <option value="original">Original subtitles</option>
                <option value="bilingual">Bilingual (Original + {translatedMeta.shortLabel})</option>
              </select>
              <Icon name="chevron_down" className="select-chevron" />
            </div>
          )}
        </div>
      )}
      {videoFile && !isAudioOnly && (
        <BurnStyleControls subtitleStyle={options.subtitleStyle} busy={busy} onChangeStyle={ctrl.updateSubtitleStyle} />
      )}
    </div>
  );
}

function ProjectSelector({ ctrl }) {
  const { state, projectId, projectRepository, loadProjectFromSnapshot, flushProjectSave } = ctrl;
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(projectId || '');
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const busy = Boolean(state.busyAction);

  useEffect(() => {
    if (!projectRepository) return undefined;
    let mounted = true;
    projectRepository.listProjects({ limit: 50, offset: 0 }).then(page => {
      if (!mounted) return;
      setProjects(page.items);
      setSelectedProjectId(prev => {
        const preferred = projectId || prev;
        return preferred && page.items.some(project => project.id === preferred) ? preferred : '';
      });
    }).catch(err => {
      if (mounted) setError(err?.message || 'Failed to load saved projects.');
    });
    return () => { mounted = false; };
  }, [projectRepository, projectId, refreshKey]);

  const handleLoadProject = async project => {
    if (!project || !project.id || !projectRepository) return;
    try {
      await flushProjectSave?.();
      const snapshot = await projectRepository.getProject(project.id);
      if (!snapshot) {
        setSelectedProjectId(projectId || '');
        setError('Project not found.');
        return;
      }
      loadProjectFromSnapshot(snapshot);
      setSelectedProjectId(project.id);
      setError('');
    } catch (err) {
      setSelectedProjectId(projectId || '');
      setError(err?.message || 'Failed to open project.');
    }
  };

  const handleDeleteProject = async project => {
    if (!project || !project.id || !projectRepository) return;
    const confirmFn = globalThis.confirm;
    if (typeof confirmFn === 'function' && !confirmFn(`Delete project "${project.title}"?`)) return;
    try {
      await projectRepository.deleteProject(project.id);
      setProjects(prev => prev.filter(item => item.id !== project.id));
      if (projectId === project.id) ctrl.clearWorkspace();
      if (selectedProjectId === project.id) setSelectedProjectId('');
      setRefreshKey(k => k + 1);
      setError('');
    } catch (err) {
      setError(err?.message || 'Failed to delete project.');
    }
  };

  const handleNewProject = async () => {
    const title = newTitle.trim();
    if (!title) { setError('Enter a project title.'); return; }
    if (!projectRepository) { setError('Project storage is unavailable.'); return; }
    try {
      await flushProjectSave?.();
      const saved = await projectRepository.saveProject(createSubtitleProjectSnapshot({ title }));
      setNewTitle('');
      setError('');
      setRefreshKey(k => k + 1);
      if (saved.project?.id) {
        loadProjectFromSnapshot(saved.project);
        setSelectedProjectId(saved.project.id);
      }
    } catch (err) {
      setError(err?.message || 'Failed to create project.');
    }
  };

  return (
    <div className="subtitle-project-selector">
      <label className="subtitle-project-label" htmlFor="subtitle-project-select">Saved projects</label>
      <div className="subtitle-project-row">
        <select id="subtitle-project-select" disabled={busy} value={selectedProjectId} onChange={e => {
          const id = e.target.value;
          setSelectedProjectId(id);
          if (!id) return;
          const project = projects.find(p => p.id === id);
          void handleLoadProject(project);
        }}>
          <option value="">Projects…</option>
          {projects.map(project => (
            <option key={project.id} value={project.id}>{project.title}</option>
          ))}
        </select>
        <input
          id="subtitle-new-project-title"
          type="text"
          placeholder="New project title"
          value={newTitle}
          disabled={busy}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleNewProject(); }}
        />
        <button type="button" id="subtitle-new-project-btn" className="button button-secondary" disabled={busy || !newTitle.trim() || !projectRepository} onClick={() => void handleNewProject()}>
          New
        </button>
        <button type="button" id="subtitle-delete-project-btn" className="button button-secondary" disabled={busy || !selectedProjectId} onClick={() => {
          const selected = projects.find(project => project.id === selectedProjectId);
          if (selected) void handleDeleteProject(selected);
        }}>
          Delete
        </button>
      </div>
      {error && <span className="subtitle-project-error" role="alert">{error}</span>}
    </div>
  );
}

function FindReplaceBar({ busy, countMatches, onReplace }) {
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [feedback, setFeedback] = useState('');
  const liveMatches = findText ? countMatches({ findText, caseSensitive }) : null;

  const handleSubmit = e => {
    e.preventDefault();
    if (!findText) return;
    const summary = onReplace({ findText, replaceText, caseSensitive });
    setFeedback(summary?.matchCount ? `Replaced ${summary.matchCount}` : 'No matches');
  };

  return (
    <form className="subtitle-find-bar" onSubmit={handleSubmit}>
      <input id="subtitle-find-input" type="text" placeholder="Find text…" aria-label="Find subtitle text"
        value={findText} disabled={busy} onChange={e => { setFindText(e.target.value); setFeedback(''); }} />
      <input id="subtitle-replace-input" type="text" placeholder="Replace with…" aria-label="Replace subtitle text"
        value={replaceText} disabled={busy} onChange={e => { setReplaceText(e.target.value); setFeedback(''); }} />
      <label className="subtitle-find-case">
        <input type="checkbox" checked={caseSensitive} disabled={busy} onChange={e => { setCaseSensitive(e.target.checked); setFeedback(''); }} />
        <span>Aa</span>
      </label>
      <button type="submit" id="subtitle-replace-all-btn" className="button button-secondary" disabled={busy || !findText}>
        Replace all
      </button>
      {(liveMatches || feedback) && (
        <span className="subtitle-find-count" role="status">
          {feedback || `${liveMatches.matchCount} ${liveMatches.matchCount === 1 ? 'match' : 'matches'}`}
        </span>
      )}
    </form>
  );
}

function SubtitleCueList({ ctrl, voice, onDeleteSegment }) {
  const { segments, speakerNames, detectedLanguage, busyAction } = ctrl.state;
  const [showFind, setShowFind] = useState(false);
  const mediaBusy = Boolean(busyAction);
  const busy = mediaBusy || voice.voiceBusy || voice.dubBusy;
  const selectedSet = new Set(voice.selectedIds);
  if (!segments.length) {
    return (
      <div className="subtitle-empty-state">
        <Icon name="subtitles" />
        <strong>No dialogue extracted yet</strong>
        <p>Upload a video or audio clip and click Extract subtitles to generate clean, editable subtitles.</p>
      </div>
    );
  }
  const hasMultiSpeakers = ctrl.speakers.length > 1;
  return (
    <div className="subtitle-cue-list">
      <div className="subtitle-cue-meta">
        <span>
          {segments.length} {segments.length === 1 ? 'segment' : 'segments'}
          {hasMultiSpeakers ? ` · ${ctrl.speakers.length} speakers` : ''}
        </span>
        <div className="subtitle-cue-meta-right">
          {detectedLanguage ? <span>Detected: {detectedLanguage.toUpperCase()}</span> : null}
          <button type="button" id="subtitle-find-toggle" className="button subtle-button subtitle-cue-btn"
            aria-expanded={showFind} onClick={() => setShowFind(v => !v)}>
            <Icon name="search" /><span>Find &amp; replace</span>
          </button>
        </div>
      </div>
      <SubtitleVoiceToolbar
        totalSegments={segments.length}
        selectedCount={voice.selectedCount}
        allSelected={voice.allSelected}
        characters={voice.characters}
        anchors={voice.anchors}
        selectedVoiceId={voice.selectedVoiceId}
        pauseGapMs={voice.pauseGapMs}
        busy={mediaBusy}
        voiceBusy={voice.voiceBusy}
        batchProgress={voice.batchProgress}
        onToggleSelectAll={voice.toggleSelectAll}
        onClearSelection={voice.clearSelection}
        onChangeVoice={voice.setSelectedVoiceId}
        onChangePauseGap={voice.setPauseGapMs}
        onGenerateSelected={() => void voice.generateSelectedVoices()}
        onCancelVoice={voice.cancelVoiceGeneration}
      />
      {showFind && <FindReplaceBar busy={busy} countMatches={ctrl.countMatches} onReplace={ctrl.findAndReplace} />}
      {segments.map((seg, index) => (
        <SubtitleSegmentRow
          key={seg.id}
          segment={seg}
          speakers={ctrl.speakers}
          speakerNames={speakerNames}
          useTranslation={ctrl.useTranslation}
          targetLangMeta={ctrl.translatedLanguageMeta}
          sourceLanguage={detectedLanguage || ctrl.state.options.sourceLanguage}
          showSpeakerBadge={hasMultiSpeakers}
          isActive={seg.id === ctrl.activeSegmentId}
          isSelected={selectedSet.has(seg.id)}
          canMergeNext={index < segments.length - 1}
          busy={busy}
          voiceClip={voice.segmentClips[seg.id] || null}
          isVoiceStale={voice.isClipStale(seg)}
          isGeneratingVoice={voice.generatingSegmentId === seg.id}
          isPlayingVoice={voice.playingSegmentId === seg.id}
          voiceDisabled={voice.voiceBusy}
          onToggleSelect={voice.toggleSelectSegment}
          onSeek={ctrl.seekToSegment}
          onUpdate={ctrl.updateSegment}
          onUpdateTiming={ctrl.updateSegmentTiming}
          onSplit={ctrl.splitSegment}
          onMergeNext={ctrl.mergeSegmentWithNext}
          onDelete={onDeleteSegment}
          onApplySuggestion={ctrl.applySegmentSuggestion}
          onDismissSuggestion={ctrl.dismissSegmentSuggestion}
          onGenerateVoice={segment => void voice.generateSegmentVoice(segment)}
          onTogglePlayVoice={voice.togglePlaySegment}
          onDownloadVoice={segment => voice.downloadSegmentVoice(segment, index)}
        />
      ))}
      <SubtitleVoiceOutputCard
        combinedClip={voice.combinedClip}
        busy={busy || voice.voiceBusy}
        dubAudioMode={voice.dubAudioMode}
        dubBusy={voice.dubBusy}
        canExportDub={voice.canExportDub}
        isAudioOnly={Boolean(ctrl.state.isAudioOnly)}
        hasJobId={Boolean(ctrl.state.jobId)}
        onDownload={voice.downloadCombinedVoice}
        onChangeDubAudioMode={voice.setDubAudioMode}
        onExportDub={() => void voice.exportDubbedVideo()}
      />
    </div>
  );
}

/**
 * Self-contained Video-to-Subtitle workspace panel hosted inside the Studio shell.
 * Inputs: `{ notices, hidden, voiceCatalog, onRefreshEngine, onSendToTts, onStateChange, onNotify, onUnlockSound }`.
 * Outputs: `<div className="workspace-panel subtitle-workspace">` element.
 * Side effects: delegates transcription, diarization, translation, MP4 burn-in, and per-frame VoxCPM2 synthesis.
 * Failure modes: displays service connectivity or processing errors cleanly in banners/dock/toasts.
 * @param {object} props - Workspace props.
 * @returns {React.ReactElement} Video-to-Subtitle workspace element.
 */
export function VideoSubtitleWorkspace({
  notices,
  hidden = false,
  voiceCatalog = null,
  actionsRef = null,
  onRefreshEngine,
  onSendToTts,
  onStateChange,
  onNotify,
  onUnlockSound,
  offlineReadiness = null,
  onSelectModels = null,
}) {
  const ctrl = useVideoSubtitles({ onNotify, onUnlockSound, hidden });
  if (actionsRef) {
    actionsRef.current = {
      loadProject: snapshot => {
        ctrl.autosave?.resetProject?.(snapshot?.id || '', snapshot?.revision || 1);
        ctrl.loadProjectFromSnapshot(snapshot);
        ctrl.recovery?.checkForDraft?.(snapshot);
        void ctrl.recovery?.verifyAssets?.(snapshot);
      },
      autosave: ctrl.autosave,
    };
  }
  const { state, health, speakers } = ctrl;
  const voice = useSubtitleVoiceover({
    segments: state.segments,
    useTranslation: ctrl.useTranslation,
    videoFile: state.videoFile,
    jobId: state.jobId,
    isAudioOnly: state.isAudioOnly,
    voiceCatalog,
    onStatus: ctrl.setStatus,
    onNotify,
    onUnlockSound,
    onEngineFailure: onRefreshEngine,
  });
  const mediaBusy = Boolean(state.busyAction);
  const busy = mediaBusy || voice.voiceBusy || voice.dubBusy;
  const modelHints = resolveModelReadinessHints(health.models, state.options);

  useEffect(() => {
    onStateChange?.({ busy, hasVideo: Boolean(state.videoFile || state.segments.length) });
  }, [busy, state.videoFile, state.segments.length, onStateChange]);

  const handleSelectFile = file => {
    if (!file) return;
    voice.resetVoiceover();
    ctrl.selectVideoFile(file);
  };
  const handleImportSubtitle = async file => {
    if (await ctrl.importSubtitleFile(file)) voice.resetVoiceover();
  };
  const handleClear = () => {
    voice.resetVoiceover();
    ctrl.clearWorkspace();
  };
  const handleCancel = () => {
    ctrl.cancel();
    voice.cancelVoiceGeneration();
  };
  const handleDeleteSegment = segId => {
    voice.removeSegmentClip(segId);
    ctrl.deleteSegment(segId);
  };
  const handleSendToTts = () => {
    const handoff = ctrl.getTtsHandoff(undefined, voice.selectedIds);
    if (!handoff.text) {
      onNotify?.({ kind: 'error', title: 'No text to send', message: 'Selected frames or speaker have no subtitle text yet.' });
      return;
    }
    if (handoff.truncated) {
      const msg = handoff.includedSegments < handoff.totalSegments
        ? `Loaded first ${handoff.includedSegments} of ${handoff.totalSegments} segments (2,000-character TTS limit).`
        : `Trimmed script to the 2,000-character TTS limit (${handoff.totalGraphemes.toLocaleString()} characters total).`;
      onNotify?.({ kind: 'success', title: 'Script trimmed for Text to speech', message: msg });
    }
    onSendToTts?.(handoff.text);
  };
  return (
    <div className="workspace-panel subtitle-workspace" hidden={hidden}>
      <div className="workspace-notices">
        {notices}
        <MediaOfflineBanner health={health} onRefresh={() => void ctrl.refreshHealth()} />
        <DraftRecoveryBanner
          visible={ctrl.recovery?.showDraftBanner}
          timestamp={ctrl.recovery?.recoveredDraft?.timestamp}
          onRestore={ctrl.recovery?.restoreDraft}
          onDiscard={ctrl.recovery?.discardDraft}
          workspace="subtitles"
        />
        <MissingAssetBanner
          visible={ctrl.recovery?.showMissingAssetBanner}
          missingAssets={ctrl.recovery?.missingAssets}
          onRelinkFile={ctrl.recovery?.relinkAssetFile}
          onDismiss={ctrl.recovery?.dismissMissingAssets}
          workspace="subtitles"
        />
      </div>
      <SubtitleToolbar
        busy={busy}
        extracting={mediaBusy}
        relinking={Boolean(state.projectId && !state.jobId && state.segments.length)}
        hasFile={Boolean(state.videoFile)}
        hasSegments={state.segments.length > 0}
        onClear={handleClear}
        onCancel={handleCancel}
        onExtract={() => void ctrl.extractSubtitles()}
        autosave={ctrl.autosave}
        offlineReadiness={offlineReadiness}
        onSelectModels={onSelectModels}
      />
      <div className="studio-grid subtitle-grid">
        <section className="subtitle-left-pane" aria-label="Video and controls">
          <VideoPreviewCard ctrl={ctrl} busy={busy} onSelectFile={handleSelectFile} onImportSubtitle={handleImportSubtitle} />
          <ProjectSelector ctrl={ctrl} />
          <SubtitleSettingsForm ctrl={ctrl} modelHints={modelHints} />
          <SpeakerRosterCard
            speakers={speakers}
            speakerNames={state.speakerNames}
            includeSpeaker={ctrl.effectiveIncludeSpeaker}
            busy={busy}
            onRename={ctrl.updateSpeakerName}
          />
        </section>
        <section className="subtitle-right-pane studio-form" aria-label="Extracted dialogue subtitles">
          <SubtitleCueList ctrl={ctrl} voice={voice} onDeleteSegment={handleDeleteSegment} />
        </section>
      </div>
      <SubtitleExportDock
        hasSegments={state.segments.length > 0}
        hasSubtitleText={ctrl.hasSubtitleText}
        selectedCount={voice.selectedCount}
        canBurn={Boolean(state.jobId) && health.burnInSupported !== false}
        hasVideoJob={Boolean(state.videoFile && state.jobId)}
        isAudioOnly={state.isAudioOnly}
        speakers={speakers}
        speakerNames={state.speakerNames}
        ttsSpeakerId={ctrl.ttsSpeakerId}
        onChangeTtsSpeakerId={ctrl.setTtsSpeakerId}
        busy={busy}
        busyAction={state.busyAction}
        busyMeta={ctrl.busyMeta}
        status={state.status}
        onExportFile={ctrl.exportFile}
        onCopyDialogue={() => void ctrl.copyDialogue()}
        onBurnVideo={() => void ctrl.burnVideo()}
        onSendToTts={handleSendToTts}
      />
    </div>
  );
}
