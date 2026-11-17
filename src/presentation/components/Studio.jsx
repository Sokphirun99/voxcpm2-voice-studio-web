/**
 * @fileoverview Top-level Voice Studio shell coordinating independent function workspaces and shared services.
 */

import React, { useCallback, useRef, useState } from 'react';
import { useAppVersionCheck } from '../hooks/useAppVersionCheck.js';
import { useEngineStatus } from '../hooks/useEngineStatus.js';
import { useVoiceAnchors } from '../hooks/useVoiceAnchors.js';
import { useVoiceLibrary } from '../hooks/useVoiceLibrary.js';
import { Icon } from './Icon.jsx';
import { DEFAULT_WORKSPACES, Sidebar } from './Sidebar.jsx';
import { TextToSpeechWorkspace, buildVoiceActions, clearCharacterLockedSeed, finalizeCharacterGeneration } from './TextToSpeechWorkspace.jsx';
import { VideoSubtitleWorkspace } from './VideoSubtitleWorkspace.jsx';
import { VoiceLibrary } from './VoiceLibrary.jsx';

export { buildVoiceActions, finalizeCharacterGeneration };

/**
 * Renders a non-destructive update banner when a newer build is ready while the workspace is busy.
 * @param {{ visible: boolean, onReload: () => void }} props - Update banner props.
 * @returns {React.ReactElement|null} Banner element or null.
 */
export function UpdateBanner({ visible, onReload }) {
  if (!visible) return null;
  return (
    <div className="update-banner" id="app-update-banner" role="status">
      <span>A new Voice Studio update is ready.</span>
      <button type="button" className="button update-reload-button" id="reload-app-button" onClick={onReload}>
        Reload now
      </button>
    </div>
  );
}

/**
 * Renders a top popup alert exclusively when VoxCPM2 goes offline so online state remains silent.
 * @param {{ visible: boolean, reason: string|null, checking?: boolean, onRetry: () => void, onDismiss: () => void }} props - Alert props.
 * @returns {React.ReactElement|null} Top alert banner or null when online.
 */
export function EngineAlertBanner({ visible, reason, checking = false, onRetry, onDismiss }) {
  if (!visible) return null;
  return (
    <div className="engine-alert-popup" id="engine-offline-banner" role="alert">
      <span className="engine-alert-dot" aria-hidden="true" />
      <div className="engine-alert-body">
        <strong>VoxCPM2 offline</strong>
        <span id="engine-offline-reason">{reason || 'Cannot reach VoxCPM2 engine on port 8808.'}</span>
      </div>
      <div className="engine-alert-actions">
        <button type="button" className="button subtle-button engine-retry-button" id="retry-engine-check"
          disabled={checking} onClick={onRetry}>{checking ? 'Checking…' : 'Retry'}</button>
        <button type="button" className="button subtle-button engine-dismiss-button" id="dismiss-engine-alert"
          aria-label="Dismiss offline message" onClick={onDismiss}><Icon name="xmark" /></button>
      </div>
    </div>
  );
}

/**
 * Renders top engine-offline and app-update notices shared across function workspaces.
 * @param {{ engineMeta: object, refreshEngine: () => void, versionCheck: object }} props - Notice state.
 * @returns {React.ReactElement} Workspace notices container.
 */
function WorkspaceNotices({ engineMeta, refreshEngine, versionCheck }) {
  return (
    <div className="workspace-notices">
      <EngineAlertBanner visible={engineMeta.showAlert} reason={engineMeta.reason} checking={engineMeta.checking}
        onRetry={refreshEngine} onDismiss={engineMeta.dismissAlert} />
      <UpdateBanner visible={versionCheck.updateAvailable} onReload={versionCheck.reloadNow} />
    </div>
  );
}

/**
 * Handles selecting a workspace function and returning focus cleanly to TTS when appropriate.
 * @param {string} id - Target workspace identifier.
 * @param {Function} setActiveWorkspace - Workspace state setter.
 * @param {{ current: object|null }} ttsRef - Active TTS workspace actions ref.
 */
function selectWorkspace(id, setActiveWorkspace, ttsRef) {
  setActiveWorkspace(id);
  if (id === 'tts') ttsRef.current?.focusScript?.();
}

/**
 * Unpins a locked voice anchor and clears its locked TTS seed consistently.
 * @param {string} id - Character ID to reset.
 * @param {{ current: object|null }} ttsRef - TTS actions ref.
 */
function resetSharedCharacterVoice(id, ttsRef) {
  clearCharacterLockedSeed(ttsRef.current?.setLockedSeeds, id);
  void ttsRef.current?.actions?.handleResetVoice(id);
}

/**
 * Coordinates the multi-function Voice Studio shell, shared Character Library, and active workspaces.
 * Inputs: none (consumes Studio services via hooks).
 * Outputs: complete Voice Studio application shell.
 * Side effects: mounts function workspaces, engine status monitor, version checker, and library modal.
 * Failure modes: per-workspace errors are surfaced cleanly within each function workspace.
 * @returns {React.ReactElement} Studio application root.
 */
export function Studio() {
  const ttsRef = useRef(null);
  const [activeWorkspace, setActiveWorkspace] = useState('tts');
  const [libraryModal, setLibraryModal] = useState({ open: false, openForm: false });
  const [externalScript, setExternalScript] = useState('');
  const [ttsState, setTtsState] = useState({ busy: false, hasScript: false });
  const [subtitleState, setSubtitleState] = useState({ busy: false, hasVideo: false });
  const handleTtsStateChange = useCallback(next => {
    setTtsState(prev => (prev.busy === next.busy && prev.hasScript === next.hasScript ? prev : next));
  }, []);
  const handleSubtitleStateChange = useCallback(next => {
    setSubtitleState(prev => (prev.busy === next.busy && prev.hasVideo === next.hasVideo ? prev : next));
  }, []);
  const handleSendToTts = useCallback(script => {
    setExternalScript(script);
    selectWorkspace('tts', setActiveWorkspace, ttsRef);
  }, []);
  const handleConsumeExternalScript = useCallback(() => setExternalScript(''), []);
  const [, refreshEngine, engineMeta] = useEngineStatus();
  const library = useVoiceLibrary();
  const anchorApi = useVoiceAnchors();
  const canAutoReload = !libraryModal.open && !ttsState.busy && !ttsState.hasScript && !subtitleState.busy && !subtitleState.hasVideo;
  const versionCheck = useAppVersionCheck({ canAutoReload });
  const notices = <WorkspaceNotices engineMeta={engineMeta} refreshEngine={refreshEngine} versionCheck={versionCheck} />;
  const subtitleNotices = <UpdateBanner visible={versionCheck.updateReady} onReload={versionCheck.reload} />;
  const shared = { library, anchorApi, refreshEngine, setLibraryModal, onTtsStateChange: handleTtsStateChange };

  return (
    <>
      <div className="studio-window">
        <Sidebar activeWorkspace={activeWorkspace} workspaces={DEFAULT_WORKSPACES}
          onSelectWorkspace={id => selectWorkspace(id, setActiveWorkspace, ttsRef)}
          onOpenLibrary={() => setLibraryModal({ open: true, openForm: false })} />
        <main className="studio-workspace">
          <TextToSpeechWorkspace shared={shared} notices={notices} hidden={activeWorkspace !== 'tts'} actionsRef={ttsRef}
            externalScript={externalScript} onConsumeExternalScript={handleConsumeExternalScript} />
          <VideoSubtitleWorkspace notices={subtitleNotices} hidden={activeWorkspace !== 'subtitles'}
            onSendToTts={handleSendToTts} onStateChange={handleSubtitleStateChange} />
        </main>
      </div>
      <VoiceLibrary open={libraryModal.open} openSaveForm={libraryModal.openForm}
        busy={ttsState.busy}
        library={library} anchors={anchorApi.anchors}
        onSelectVoice={voice => void ttsRef.current?.actions?.handleSelectCharacter(voice)}
        onCreateCharacter={input => ttsRef.current?.actions?.handleCreateCharacter(input)}
        onDeleteCharacter={id => void ttsRef.current?.actions?.handleDeleteCharacter(id)}
        onUnpinAnchor={id => resetSharedCharacterVoice(id, ttsRef)}
        onClose={() => setLibraryModal({ open: false, openForm: false })} />
    </>
  );
}
