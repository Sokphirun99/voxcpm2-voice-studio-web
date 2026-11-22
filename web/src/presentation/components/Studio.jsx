/**
 * @fileoverview Top-level Voice Studio shell coordinating top-level function workspaces and shared Character Domain state.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_CHARACTER_ID, findCharacterById } from '../../domain/voiceLibrary.js';
import { clearLastActiveProject, getLastActiveProject, saveLastActiveProject } from '../../data/projectRecoveryStorage.js';
import { useStudioServices } from '../StudioContext.jsx';
import { useAppVersionCheck } from '../hooks/useAppVersionCheck.js';
import { useCharacterActions } from '../hooks/useCharacterActions.js';
import { useEngineStatus } from '../hooks/useEngineStatus.js';
import { useNotifications } from '../hooks/useNotifications.js';
import { useOfflineReadiness } from '../hooks/useOfflineReadiness.js';
import { useVoiceAnchors } from '../hooks/useVoiceAnchors.js';
import { useVoiceLibrary } from '../hooks/useVoiceLibrary.js';
import { Icon } from './Icon.jsx';
import { ModelsSetupWorkspace } from './ModelsSetupWorkspace.jsx';
import { ProjectsWorkspace } from './ProjectsWorkspace.jsx';
import { DEFAULT_WORKSPACES, Sidebar } from './Sidebar.jsx';
import { TextToSpeechWorkspace, buildVoiceActions, clearCharacterLockedSeed, finalizeCharacterGeneration } from './TextToSpeechWorkspace.jsx';
import { ToastRegion } from './ToastRegion.jsx';
import { VideoSubtitleWorkspace } from './VideoSubtitleWorkspace.jsx';

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

function WorkspaceNotices({ engineMeta, refreshEngine, versionCheck }) {
  return (
    <div className="workspace-notices">
      <EngineAlertBanner visible={engineMeta.showAlert} reason={engineMeta.reason} checking={engineMeta.checking}
        onRetry={refreshEngine} onDismiss={engineMeta.dismissAlert} />
      <UpdateBanner visible={versionCheck.updateAvailable} onReload={versionCheck.reloadNow} />
    </div>
  );
}

function selectWorkspace(id, setActiveWorkspace, ttsRef) {
  setActiveWorkspace(id);
  if (id === 'tts') ttsRef.current?.focusScript?.();
}

function useSharedCharacterCatalog({ ttsRef, onNotify, onUnlockSound }) {
  const library = useVoiceLibrary();
  const anchorApi = useVoiceAnchors();
  const [selectedCharacterId, setSelectedCharacterId] = useState(DEFAULT_CHARACTER_ID);
  const [lockedSeeds, setLockedSeeds] = useState({});

  const activeCharacter = useMemo(
    () => findCharacterById(library.allVoices, selectedCharacterId),
    [library.allVoices, selectedCharacterId]
  );
  const activeAnchor = anchorApi.anchors[activeCharacter.id] || null;
  const actions = useCharacterActions({
    activeCharacter,
    library,
    anchorApi,
    onCharacterSelected: setSelectedCharacterId,
    onClearLockedSeed: id => clearCharacterLockedSeed(setLockedSeeds, id),
    onCancelCharacterSynthesis: id => ttsRef.current?.cancelIfCharacter?.(id),
    onCloseLibrary: () => ttsRef.current?.closeLibrary?.(),
    onStatus: next => ttsRef.current?.setStatus?.(next),
    onNotify,
    onUnlockSound,
  });

  return { library, anchorApi, activeCharacter, activeAnchor, lockedSeeds, setLockedSeeds, actions };
}

async function resolveProjectSnapshot(project, repo, logger) {
  if (!project) return null;
  if (!repo || project.payload || project.segments) return project;
  try {
    const fetched = await repo.getProject(project.id);
    return fetched || project;
  } catch (error) {
    logger?.error?.('Studio.resolveProjectSnapshot', error, { projectId: project.id });
    return project;
  }
}

async function flushWorkspaceBeforeProjectSwitch(ttsRef, subtitlesRef) {
  const saves = [];
  if (ttsRef.current?.autosave?.isDirty) saves.push(ttsRef.current.autosave.saveNow());
  if (subtitlesRef.current?.autosave?.isDirty) saves.push(subtitlesRef.current.autosave.saveNow());
  if (saves.length > 0) await Promise.all(saves);
}

async function openWorkspaceProject({ project, repo, logger, ttsRef, subtitlesRef, setActiveWorkspace }) {
  if (!project) return;
  await flushWorkspaceBeforeProjectSwitch(ttsRef, subtitlesRef);
  const snapshot = await resolveProjectSnapshot(project, repo, logger);
  const type = snapshot?.type || (snapshot?.kind === 'subtitle' ? 'subtitles' : 'tts');
  if (snapshot?.id) saveLastActiveProject({ projectId: snapshot.id, workspace: type, logger });
  if (type === 'tts') {
    ttsRef.current?.loadProject?.(snapshot);
    setActiveWorkspace('tts');
    ttsRef.current?.focusScript?.();
    return;
  }
  subtitlesRef.current?.loadProject?.(snapshot);
  setActiveWorkspace('subtitles');
}

function useRestoreLastActiveProject({ services, ttsRef, subtitlesRef, setActiveWorkspace }) {
  useEffect(() => {
    let mounted = true;
    const restoreActive = async () => {
      const record = getLastActiveProject({ logger: services?.logger });
      if (!record?.projectId || !services?.projectRepository) return;
      try {
        const project = await services.projectRepository.getProject(record.projectId);
        if (!mounted || !project) return;
        await openWorkspaceProject({
          project,
          repo: services.projectRepository,
          logger: services.logger,
          ttsRef,
          subtitlesRef,
          setActiveWorkspace,
        });
      } catch (err) {
        services?.logger?.error?.('Studio.restoreLastActiveProject', err, { projectId: record.projectId });
        clearLastActiveProject({ logger: services?.logger });
      }
    };
    void restoreActive();
    return () => { mounted = false; };
  }, [services, ttsRef, subtitlesRef, setActiveWorkspace]);
}

/**
 * Coordinates the top-level Voice Studio function workspaces (`Text to speech`, `Video to subtitle`) and shared character data.
 * Inputs: none (consumes Studio services via hooks).
 * Outputs: complete Voice Studio application shell.
 * Side effects: mounts function workspaces plus update and engine monitors.
 * Failure modes: per-workspace errors surface cleanly inside each workspace's status bar/banner.
 * @returns {React.ReactElement} Studio application root.
 */
export function Studio() {
  const ttsRef = useRef(null);
  const subtitlesRef = useRef(null);
  const [activeWorkspace, setActiveWorkspace] = useState(() => {
    const initial = getLastActiveProject();
    return initial?.workspace === 'subtitles' ? 'subtitles' : 'tts';
  });
  const [externalScript, setExternalScript] = useState('');
  const [ttsState, setTtsState] = useState({ busy: false, hasScript: false, libraryOpen: false });
  const [subtitleState, setSubtitleState] = useState({ busy: false, hasVideo: false });
  const notifications = useNotifications();
  const services = useStudioServices();
  useRestoreLastActiveProject({ services, ttsRef, subtitlesRef, setActiveWorkspace });
  const handleTtsStateChange = useCallback(next => {
    setTtsState(prev => (prev.busy === next.busy && prev.hasScript === next.hasScript && prev.libraryOpen === next.libraryOpen ? prev : next));
  }, []);
  const handleSubtitleStateChange = useCallback(next => {
    setSubtitleState(prev => (prev.busy === next.busy && prev.hasVideo === next.hasVideo ? prev : next));
  }, []);
  const handleSendToTts = useCallback(script => {
    setExternalScript(script);
    selectWorkspace('tts', setActiveWorkspace, ttsRef);
  }, []);
  const handleOpenProject = useCallback(project => {
    void openWorkspaceProject({ project, repo: services?.projectRepository, logger: services?.logger, ttsRef, subtitlesRef, setActiveWorkspace });
  }, [services, setActiveWorkspace]);
  const handleConsumeExternalScript = useCallback(() => setExternalScript(''), []);
  const [, refreshEngine, engineMeta] = useEngineStatus();
  const { readiness: offlineReadiness } = useOfflineReadiness({ gateway: services?.diagnosticsGateway });
  const handleSelectModels = useCallback(() => {
    selectWorkspace('models', setActiveWorkspace, ttsRef);
  }, []);
  const catalog = useSharedCharacterCatalog({
    ttsRef,
    onNotify: notifications.notify,
    onUnlockSound: notifications.unlockSound,
  });
  const canAutoReload = !ttsState.libraryOpen && !ttsState.busy && !ttsState.hasScript && !subtitleState.busy && !subtitleState.hasVideo;
  const versionCheck = useAppVersionCheck({ canAutoReload });
  const ttsNotices = <WorkspaceNotices engineMeta={engineMeta} refreshEngine={refreshEngine} versionCheck={versionCheck} />;
  const updateBanner = <UpdateBanner visible={versionCheck.updateAvailable} onReload={versionCheck.reloadNow} />;
  const sharedTts = {
    library: catalog.library,
    anchorApi: catalog.anchorApi,
    activeCharacter: catalog.activeCharacter,
    activeAnchor: catalog.activeAnchor,
    lockedSeeds: catalog.lockedSeeds,
    setLockedSeeds: catalog.setLockedSeeds,
    characterActions: catalog.actions,
    refreshEngine,
    offlineReadiness,
    onSelectModels: handleSelectModels,
    onTtsStateChange: handleTtsStateChange,
    onNotify: notifications.notify,
    onUnlockSound: notifications.unlockSound,
  };

  const subtitleVoiceCatalog = useMemo(() => ({
    characters: catalog.library.allVoices,
    anchors: catalog.anchorApi.anchors,
    defaultCharacterId: catalog.activeCharacter.id,
    lockedSeeds: catalog.lockedSeeds,
  }), [catalog.library.allVoices, catalog.anchorApi.anchors, catalog.activeCharacter.id, catalog.lockedSeeds]);

  return (
    <div className="studio-window">
      <Sidebar
        activeWorkspace={activeWorkspace}
        workspaces={DEFAULT_WORKSPACES}
        onSelectWorkspace={id => selectWorkspace(id, setActiveWorkspace, ttsRef)}
        soundMuted={notifications.soundMuted}
        onToggleSoundMuted={notifications.toggleSoundMuted}
      />
      <main className="studio-workspace">
        <ProjectsWorkspace
          hidden={activeWorkspace !== 'projects'}
          onOpenProject={handleOpenProject}
          onNotify={notifications.notify}
          projectRepository={services?.projectRepository}
        />
        <TextToSpeechWorkspace shared={sharedTts} notices={ttsNotices} hidden={activeWorkspace !== 'tts'} actionsRef={ttsRef}
          externalScript={externalScript} onConsumeExternalScript={handleConsumeExternalScript} />
        <VideoSubtitleWorkspace
          notices={updateBanner}
          hidden={activeWorkspace !== 'subtitles'}
          voiceCatalog={subtitleVoiceCatalog}
          actionsRef={subtitlesRef}
          onRefreshEngine={refreshEngine}
          onSendToTts={handleSendToTts}
          onStateChange={handleSubtitleStateChange}
          onNotify={notifications.notify}
          onUnlockSound={notifications.unlockSound}
          offlineReadiness={offlineReadiness}
          onSelectModels={handleSelectModels}
        />
        <ModelsSetupWorkspace
          hidden={activeWorkspace !== 'models'}
          diagnosticsGateway={services?.diagnosticsGateway}
        />
      </main>
      <ToastRegion toasts={notifications.toasts} onDismiss={notifications.dismiss} />
    </div>
  );
}
