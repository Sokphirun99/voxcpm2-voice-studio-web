/**
 * @fileoverview Accessible Voice Studio workspace displaying system health, AI model cache readiness, and storage diagnostics.
 */

import React from 'react';
import { useModelDiagnostics } from '../hooks/useModelDiagnostics.js';
import { Icon } from './Icon.jsx';

const MODEL_STATE_LABELS = Object.freeze({
  ready: 'Ready',
  not_installed: 'Not Installed',
  downloading: 'Downloading…',
  loading: 'Loading…',
  unavailable: 'Unavailable',
  error: 'Error',
});

function ToolbarTitle({ lastRefreshedAt }) {
  return (
    <div className="toolbar-title-group">
      <h1>Models &amp; Setup</h1>
      {lastRefreshedAt && <span className="toolbar-subtitle">Checked at {lastRefreshedAt}</span>}
    </div>
  );
}

/**
 * Renders the top toolbar for the Models & Setup workspace.
 * @param {{ loading: boolean, lastRefreshedAt: string|null, onRefresh: () => void }} props - Toolbar props.
 * @returns {React.ReactElement} Toolbar element.
 */
function ModelsSetupToolbar({ loading, lastRefreshedAt, onRefresh }) {
  return (
    <header className="studio-toolbar">
      <ToolbarTitle lastRefreshedAt={lastRefreshedAt} />
      <div className="toolbar-actions">
        <button
          type="button"
          id="refresh-diagnostics-btn"
          className="button subtle-button refresh-diagnostics-btn"
          disabled={loading}
          onClick={() => onRefresh()}
          aria-label="Refresh diagnostics"
        >
          <Icon name="refresh" className={loading ? 'spinning' : ''} />
          <span>{loading ? 'Checking…' : 'Refresh diagnostics'}</span>
        </button>
      </div>
    </header>
  );
}

function resolveHeroPillLabel(overall) {
  if (overall.status === 'offline_cached_available') return 'Offline (Cached Features Available)';
  if (overall.status === 'downloads_required') return 'Downloads Required';
  return 'Setup Required';
}

function resolveHeroBannerClass(overall) {
  if (overall.isOfflineReady) return 'readiness-ready';
  if (overall.status === 'offline_cached_available') return 'readiness-offline-cached';
  return 'readiness-warning';
}

/**
 * Renders the hero readiness badge and status announcement.
 * @param {{ overall: object|null }} props - Overall readiness descriptor.
 * @returns {React.ReactElement|null} Hero banner element.
 */
function ReadinessHeroBanner({ overall }) {
  if (!overall) return null;
  const isReady = overall.isOfflineReady;
  const statusClass = resolveHeroBannerClass(overall);
  const pillLabel = resolveHeroPillLabel(overall);
  return (
    <section className={`models-hero-banner ${statusClass}`} role="status" aria-live="polite">
      <div className="models-hero-icon"><Icon name={isReady ? 'check_circle' : 'alert_circle'} /></div>
      <div className="models-hero-body">
        <div className="models-hero-title-row">
          <strong id="readiness-label">{overall.label}</strong>
          {!isReady && <span className={`status-pill status-${overall.status}`}>{pillLabel}</span>}
        </div>
        <p id="readiness-description" className="models-hero-desc">{overall.description}</p>
      </div>
    </section>
  );
}

/**
 * Renders plain-language recovery and download instructions.
 * @param {{ instructions: Array<string> }} props - Instruction list.
 * @returns {React.ReactElement|null} Instructions panel element.
 */
function InstructionsPanel({ instructions }) {
  if (!instructions || instructions.length === 0) return null;
  return (
    <section className="diagnostics-instructions-panel" aria-label="Actionable setup steps">
      <h2 className="section-title">
        <Icon name="alert_circle" />
        <span>Actionable Setup Steps</span>
      </h2>
      <ul className="instructions-list">
        {instructions.map((text, idx) => (
          <li key={idx} className="instruction-item">
            <code>{text}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OfflineFeatureRow({ feature }) {
  const isReady = feature.isOfflineReady;
  const statusLabel = isReady ? 'Offline Ready' : `Download required (~${feature.approxSize})`;
  const statusClass = isReady ? 'ready' : 'downloads_required';
  return (
    <li className="instruction-item offline-feature-row">
      <div className="models-hero-title-row">
        <strong>{feature.name}</strong>
        <span className={`status-pill status-${statusClass}`}>{statusLabel}</span>
      </div>
      <div className="card-meta">
        <span className="card-repo">{feature.repo}</span>
      </div>
      {!isReady && <p className="card-detail">{feature.firstUseRequirement}</p>}
    </li>
  );
}

function OfflineBreakdownPanel({ offlineReadiness }) {
  const features = offlineReadiness?.features;
  if (!features || features.length === 0) return null;
  return (
    <section className="models-section offline-breakdown-panel" aria-label="Feature offline readiness">
      <h2 className="section-title">
        <Icon name="cpu" />
        <span>Feature Offline Readiness</span>
      </h2>
      <ul className="offline-feature-list">
        {features.map(feat => <OfflineFeatureRow key={feat.id} feature={feat} />)}
      </ul>
    </section>
  );
}

/**
 * Renders a card displaying local service health.
 * @param {{ service: object }} props - Service status record.
 * @returns {React.ReactElement} Service status card.
 */
function ServiceCard({ service }) {
  const isOnline = service.status === 'online';
  return (
    <article className={`diagnostic-card service-card ${isOnline ? 'card-online' : 'card-offline'}`}>
      <div className="card-header">
        <Icon name="server" />
        <h3 className="card-title">{service.name}</h3>
        <span className={`status-pill status-${service.status}`}>{isOnline ? 'Online' : 'Offline'}</span>
      </div>
      <p className="card-detail">{service.details}</p>
      <div className="card-meta"><span>Port {service.port}</span></div>
    </article>
  );
}

function ModelCardMeta({ task, device }) {
  return (
    <div className="card-meta">
      <span className="meta-task">{task}</span>
      {device && <span className="meta-device">{device}</span>}
    </div>
  );
}

/**
 * Renders a card displaying AI model cache and readiness state.
 * @param {{ model: object }} props - Model record.
 * @returns {React.ReactElement} Model diagnostic card.
 */
function ModelCard({ model }) {
  const label = MODEL_STATE_LABELS[model.state] || 'Unknown';
  return (
    <article className={`diagnostic-card model-card state-${model.state}`}>
      <div className="card-header">
        <Icon name="cpu" />
        <div className="card-title-group">
          <h3 className="card-title">{model.name}</h3>
          <span className="card-repo">{model.repo}</span>
        </div>
        <span className={`status-pill status-${model.state}`} id={`model-status-${model.id}`}>{label}</span>
      </div>
      <p className="card-detail">{model.description}</p>
      <ModelCardMeta task={model.task} device={model.device} />
    </article>
  );
}

function StorageStatItem({ label, value, sub, id }) {
  return (
    <div className="storage-stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value" id={id}>{value}</strong>
      <span className="stat-sub">{sub}</span>
    </div>
  );
}

function StorageStatsGrid({ storage }) {
  const hasRss = Boolean(storage.containerRssBytes && storage.containerRssBytes > 0);
  return (
    <div className="storage-grid">
      <StorageStatItem label="Volume Free" value={storage.volumeFreeFormatted} sub={`of ${storage.volumeTotalFormatted}`} id="storage-volume-free" />
      <StorageStatItem label="Characters" value={storage.charactersCount} sub="in catalog" id="storage-characters-count" />
      <StorageStatItem label="Voice Anchors" value={storage.anchorsCount} sub={storage.anchorBytesFormatted} id="storage-anchors-count" />
      <StorageStatItem label="Synthesis Cache" value={`${storage.cacheEntriesCount} / ${storage.maxCacheEntries}`} sub={storage.cacheBytesFormatted} id="storage-cache-count" />
      {hasRss && <StorageStatItem label="Container RAM" value={storage.containerRssFormatted} sub="rss memory" id="storage-container-rss" />}
    </div>
  );
}

/**
 * Renders storage volume headroom and catalog metrics.
 * @param {{ storage: object|null }} props - Storage metrics.
 * @returns {React.ReactElement|null} Storage metrics panel.
 */
function StorageMetricsCard({ storage }) {
  if (!storage) return null;
  const isHealthy = storage.headroomState === 'healthy';
  return (
    <section className="diagnostic-card storage-card" aria-label="Storage capacity and catalog stats">
      <div className="card-header">
        <Icon name="database" />
        <h2 className="card-title">Storage Headroom &amp; Catalog</h2>
        <span className={`status-pill status-${storage.headroomState}`}>{isHealthy ? 'Headroom Healthy' : 'Low Disk Space'}</span>
      </div>
      <StorageStatsGrid storage={storage} />
    </section>
  );
}

function ServicesSection({ services }) {
  return (
    <section className="models-section models-services" aria-label="Local backend services status">
      <h2 className="section-title">Local Backend Services</h2>
      <div className="services-grid">
        {services?.map(service => <ServiceCard key={service.id} service={service} />)}
      </div>
    </section>
  );
}

function ModelsSection({ models }) {
  return (
    <section className="models-section" aria-label="AI models and pipeline tools">
      <h2 className="section-title">AI Models &amp; Pipeline Tools</h2>
      <div className="models-grid">
        {models?.map(model => <ModelCard key={model.id} model={model} />)}
      </div>
    </section>
  );
}

function resolveHeroOverall(diagnostics) {
  if (diagnostics?.offlineReadiness?.status === 'offline_cached_available') {
    return diagnostics.offlineReadiness;
  }
  return diagnostics?.overall || diagnostics?.offlineReadiness || null;
}

function ModelsWorkspaceContent({ diagnostics, error }) {
  const heroOverall = resolveHeroOverall(diagnostics);
  return (
    <div className="models-workspace-content">
      {error && <div className="models-error-alert" role="alert">{error}</div>}
      <ReadinessHeroBanner overall={heroOverall} />
      <InstructionsPanel instructions={diagnostics?.instructions} />
      <div className="models-overview">
        <ServicesSection services={diagnostics?.services} />
        <OfflineBreakdownPanel offlineReadiness={diagnostics?.offlineReadiness} />
      </div>
      <ModelsSection models={diagnostics?.models} />
      <StorageMetricsCard storage={diagnostics?.storage} />
    </div>
  );
}

/**
 * Top-level Models & Setup workspace screen.
 * Inputs: `{ hidden, diagnosticsGateway, initialDiagnostics }`.
 * Outputs: Complete diagnostic workspace pane.
 * Side effects: executes async diagnostic probes on mount and on refresh.
 * Failure modes: renders offline/uninstalled warnings cleanly.
 * @param {{ hidden?: boolean, diagnosticsGateway?: object, initialDiagnostics?: object|null }} props - Workspace props.
 * @returns {React.ReactElement} Models setup workspace.
 */
export function ModelsSetupWorkspace({ hidden = false, diagnosticsGateway = null, initialDiagnostics = null }) {
  const state = useModelDiagnostics({ gateway: diagnosticsGateway, initialDiagnostics, active: !hidden });
  return (
    <div className="workspace-panel models-workspace" id="models-workspace-pane" hidden={hidden} tabIndex={-1} aria-label="Models &amp; Setup">
      <ModelsSetupToolbar loading={state.loading} lastRefreshedAt={state.lastRefreshedAt} onRefresh={state.refresh} />
      <ModelsWorkspaceContent diagnostics={state.diagnostics} error={state.error} />
    </div>
  );
}
