/**
 * @fileoverview Entry point and composition root wiring Data adapters -> Domain use cases -> Presentation UI.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/noto-sans-khmer';
import './presentation/styles/studio.css';
import { createConsoleLogger } from './data/consoleLogger.js';
import { createGradioSpeechGateway } from './data/gradioSpeechGateway.js';
import { createHttpAudioMaster } from './data/httpAudioMaster.js';
import { createDockerVoiceAnchorRepository } from './data/httpAudioRepository.js';
import { createHttpSynthesisCache } from './data/httpSynthesisCache.js';
import { createHttpVersionChecker } from './data/httpVersionChecker.js';
import { createHttpVoiceRepository } from './data/httpVoiceRepository.js';
import { createIndexedDbVoiceAnchorRepository } from './data/indexedDbAudioRepository.js';
import { createLocalVoiceRepository } from './data/localVoiceRepository.js';
import { createMediaSubtitleGateway } from './data/mediaSubtitleGateway.js';
import { createWebAudioDecoder } from './data/webAudioDecoder.js';
import {
  createLockReferenceAudioUseCase,
  createSynthesizeSpeechUseCase,
  createVoiceAnchorUseCases,
  createVoiceLibraryUseCases,
} from './domain/useCases.js';
import { StudioProvider } from './presentation/StudioContext.jsx';
import { ErrorBoundary } from './presentation/components/ErrorBoundary.jsx';
import { Studio } from './presentation/components/Studio.jsx';

/**
 * Instantiates concrete Data adapters and injects them into Domain use cases.
 * Inputs: none.
 * Outputs: service bundle passed to `<StudioProvider>`.
 * Side effects: none until services are invoked by UI hooks.
 * Failure modes: throws if port contract assertions fail during startup.
 * @returns {object} Wired application service container.
 */
function createStudioServices() {
  const logger = createConsoleLogger();
  const speechGateway = createGradioSpeechGateway({ logger });
  const audioMaster = createHttpAudioMaster({ logger });
  const synthesisCache = createHttpSynthesisCache({ logger });
  const localVoices = createLocalVoiceRepository({ logger });
  const remoteVoices = createHttpVoiceRepository({ logger });
  const localAnchors = createIndexedDbVoiceAnchorRepository({ logger });
  const anchorRepository = createDockerVoiceAnchorRepository({ localRepository: localAnchors, logger });
  const audioDecoder = createWebAudioDecoder();
  const versionChecker = createHttpVersionChecker({ logger });
  const mediaSubtitleGateway = createMediaSubtitleGateway({ logger });

  return {
    speechGateway,
    mediaSubtitleGateway,
    audioDecoder,
    versionChecker,
    logger,
    synthesizeSpeech: createSynthesizeSpeechUseCase({ speechGateway, audioMaster, synthesisCache }),
    lockReferenceAudio: createLockReferenceAudioUseCase(),
    voiceLibrary: createVoiceLibraryUseCases({ voiceRepository: localVoices, remoteRepository: remoteVoices }),
    voiceAnchors: createVoiceAnchorUseCases({ anchorRepository }),
  };
}

const rootElement = document.getElementById('app');
if (!rootElement) {
  throw new Error('Could not find #app root container.');
}

const services = createStudioServices();

createRoot(rootElement).render(
  <div className="studio-page">
    <StudioProvider services={services}>
      <ErrorBoundary logger={services.logger}>
        <Studio />
      </ErrorBoundary>
    </StudioProvider>
  </div>
);
