/**
 * @fileoverview React dependency injection context providing domain use cases and ports to presentation hooks.
 */

import React, { createContext, useContext } from 'react';

const StudioContext = createContext(null);

/**
 * Provides wired domain use cases and adapters to the presentation layer.
 * Inputs: `{ services, children }`.
 * Outputs: React Context provider element.
 * Side effects: none.
 * Failure modes: throws if consumed outside `<StudioProvider>`.
 * @param {{ services: object, children: React.ReactNode }} props - Provider props.
 * @returns {React.ReactElement} Context provider.
 */
export function StudioProvider({ services, children }) {
  return <StudioContext.Provider value={services}>{children}</StudioContext.Provider>;
}

/**
 * Retrieves injected studio domain use cases and ports from context.
 * Inputs: none.
 * Outputs: services bundle including speech, voice, media subtitle, and project repositories.
 * Side effects: none.
 * Failure modes: throws Error when called outside `<StudioProvider>`.
 * @returns {object} Injected service container.
 */
export function useStudioServices() {
  const services = useContext(StudioContext);
  if (!services) {
    throw new Error('useStudioServices must be used within <StudioProvider>.');
  }
  return services;
}
