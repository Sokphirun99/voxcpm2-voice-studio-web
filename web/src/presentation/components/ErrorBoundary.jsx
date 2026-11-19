/**
 * @fileoverview React error boundary preventing unhandled render exceptions from blanking the screen.
 */

import React from 'react';

/**
 * Catches descendant React rendering errors and renders a one-click workspace reset UI.
 */
export class ErrorBoundary extends React.Component {
  /**
   * Initializes boundary state.
   * @param {{ children: React.ReactNode, logger?: import('../../domain/ports.js').LoggerPort }} props - Boundary props.
   */
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  /**
   * Marks error state when a descendant throws during render.
   * @returns {{ hasError: boolean }} Next state.
   */
  static getDerivedStateFromError() {
    return { hasError: true };
  }

  /**
   * Delegates caught component errors to the injected logger port.
   * @param {Error} error - Caught exception.
   * @param {{ componentStack?: string }} info - React component stack metadata.
   */
  componentDidCatch(error, info) {
    this.props.logger?.error('ErrorBoundary.componentDidCatch', error, { componentStack: info?.componentStack?.slice(0, 300) });
  }

  /**
   * Renders children or a recovery panel on render error.
   * @returns {React.ReactNode} UI tree or fallback card.
   */
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main className="studio-crash-fallback" role="alert">
        <h1>Voice Studio encountered an unexpected display error</h1>
        <p>Reset the workspace to continue without losing your saved voice library.</p>
        <button type="button" className="button generate" onClick={() => this.setState({ hasError: false })}>
          Reload workspace
        </button>
      </main>
    );
  }
}
