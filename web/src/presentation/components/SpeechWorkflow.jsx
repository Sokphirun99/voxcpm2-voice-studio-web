import React, { useState } from 'react';
import { Icon } from './Icon.jsx';

const STEPS = [
  { id: 'prepare', title: 'Prepare script', icon: 'text_quote', detail: 'Voice Studio checks the script and voice settings, applies pronunciation rules, and splits longer text into chunks.' },
  { id: 'cache', title: 'Check audio cache', icon: 'database', detail: 'Docker storage checks for matching audio from an earlier run. A cache hit goes straight to the player.' },
  { id: 'reference', title: 'Prepare voice reference', icon: 'upload', detail: 'If the voice uses a reference sample, the gateway reuses its upload or sends it to the local engine.' },
  { id: 'generate', title: 'Generate speech', icon: 'waveform', detail: 'VoxCPM2 generates audio on your Mac. For multiple speakers, this stage includes each segment’s cache and reference checks.' },
  { id: 'finish', title: 'Join and finish audio', icon: 'merge', detail: 'Voice Studio joins chunks when needed and applies mastering when enabled.' },
  { id: 'ready', title: 'Audio ready', icon: 'play_fill', detail: 'The finished WAV is available for preview and download in Text to speech.' },
];

const EDGES = [
  ['prepare', 'cache', 'M273 80H327'],
  ['cache', 'reference', 'M573 80H627'],
  ['reference', 'generate', 'M750 136V184'],
  ['generate', 'finish', 'M627 240H573'],
  ['finish', 'ready', 'M327 240H273'],
  ['cache', 'ready', 'M420 136C420 166 150 148 150 184', 'shortcut'],
  ['cache', 'generate', 'M480 136C480 166 750 148 750 184', 'shortcut'],
  ['prepare', 'generate', 'M180 136C180 174 660 146 660 184', 'multi'],
];

const VERTICAL_PATHS = [
  'M450 92V116', 'M450 192V216', 'M450 292V316', 'M450 392V416', 'M450 492V516',
  'M765 154C860 154 860 170 860 180V528C860 554 815 554 765 554',
  'M765 154C815 154 815 170 815 180V328C815 354 790 354 765 354',
  'M135 54C70 54 70 80 70 100V315C70 354 100 354 135 354',
];

function WorkflowEdges({ stages, run, vertical = false }) {
  const active = stages.at(-1);
  return (
    <svg className={vertical ? 'workflow-edges-vertical' : 'workflow-edges-horizontal'} viewBox={vertical ? '0 0 900 608' : '0 0 900 320'} preserveAspectRatio="none" aria-hidden="true">
      {EDGES.map(([from, to, path, kind], index) => {
        if (kind === 'multi' && !run?.multiSpeaker) return null;
        const fromIndex = stages.indexOf(from);
        const visited = fromIndex >= 0 && stages[fromIndex + 1] === to;
        const state = visited ? (to === active ? run.status : 'done') : 'idle';
        return <path key={from + to} d={vertical ? VERTICAL_PATHS[index] : path} data-kind={kind} data-state={state} vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
}

const STATUS_LABELS = {
  idle: 'Waiting', running: 'Running', done: 'Done', skipped: 'Skipped',
  failed: 'Failed', cancelled: 'Cancelled', grouped: 'Per segment',
};

function getStepStatus(id, stages, run) {
  if (stages.includes(id)) {
    return id === stages.at(-1) ? run.status : 'done';
  }
  if (run?.multiSpeaker && ['cache', 'reference'].includes(id) && stages.includes('generate')) return 'grouped';
  const lastIndex = STEPS.findIndex(step => step.id === stages.at(-1));
  const index = STEPS.findIndex(step => step.id === id);
  if (index < lastIndex || (run && ['failed', 'cancelled'].includes(run.status))) return 'skipped';
  return 'idle';
}

export function SpeechWorkflow({ run }) {
  const [selected, setSelected] = useState(null);
  const stages = run?.stages ?? [];
  const active = stages.at(-1);
  const detail = STEPS.find(step => step.id === (selected ?? active ?? 'prepare'));
  const cached = stages.includes('cache') && stages.includes('ready') && !stages.includes('generate');

  return (
    <section className="models-section speech-workflow" aria-label="Text to speech workflow">
      <div className="speech-workflow-heading">
        <h2 className="section-title">Text to speech workflow</h2>
        <span role="status">
          {run ? (cached ? 'Ready from cache' : STATUS_LABELS[run.status]) : 'Waiting for a speech run'}
        </span>
      </div>
      <div className="speech-workflow-diagram">
        <div className="speech-workflow-graph">
          <WorkflowEdges stages={stages} run={run} />
          <WorkflowEdges stages={stages} run={run} vertical />
          <ol>
            {STEPS.map(step => {
              const status = getStepStatus(step.id, stages, run);
              return (
                <li key={step.id}>
                  <button type="button" id={`speech-workflow-${step.id}`} data-step={step.id} data-state={status} aria-pressed={step === detail} onClick={() => setSelected(step.id)}>
                    <span className="speech-workflow-icon"><Icon name={step.icon} /></span>
                    <strong>{step.title}</strong>
                    <small>{STATUS_LABELS[status]}</small>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <div className="speech-workflow-detail">
        <strong>{detail.title}</strong>
        <p>{detail.detail}</p>
      </div>
    </section>
  );
}
