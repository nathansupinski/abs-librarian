import React, { useState, useEffect, useRef } from 'react';
import { Play, Square, Terminal, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { usePlan, useUpdateSettings } from '../hooks/usePlan.js';

const FLAG_DEFS = [
  { key: 'autoAcceptReview',     label: '--auto-accept-review',     desc: 'Move best-guesses to their suggested dest instead of _NeedsReview/' },
  { key: 'deleteJunk',           label: '--delete-junk',             desc: 'Delete system files, Mac metadata, empty dirs, download artifacts' },
  { key: 'deleteEmptyShells',    label: '--delete-empty-shells',     desc: 'Remove dirs with no audio after all moves' },
  { key: 'retryFailed',          label: '--retry-failed',            desc: 'Retry items that failed in a previous execute run' },
  { key: 'forceDeleteAudioJunk', label: '--force-delete-audio-junk', desc: 'Bypass audio-extension safety check (rarely needed)' },
];

export default function RunControls() {
  const qc = useQueryClient();
  const { data: plan } = usePlan();
  const updateSettings = useUpdateSettings();
  const [running, setRunning]         = useState(false);
  const [runType, setRunType]         = useState(null);
  const [exitCode, setExitCode]       = useState(null);
  const [output, setOutput]           = useState('');
  const [showLog, setShowLog]         = useState(false);
  const [showFlags, setShowFlags]     = useState(false);
  const [flags, setFlags]             = useState({
    autoAcceptReview: false,
    deleteJunk: false,
    deleteEmptyShells: false,
    retryFailed: false,
    forceDeleteAudioJunk: false,
  });
  const [dupFolderInput, setDupFolderInput] = useState('');
  const logRef  = useRef(null);
  const outputRef = useRef('');

  useEffect(() => {
    setDupFolderInput(plan?.settings?.duplicatesFolder ?? '');
  }, [plan?.settings?.duplicatesFolder]);

  useEffect(() => {
    const es = new EventSource('/api/run/stream');

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === 'status') {
        setRunning(msg.running);
        setRunType(msg.runType ?? null);
      } else if (msg.event === 'start') {
        setRunning(true);
        setRunType(msg.runType);
        setExitCode(null);
        outputRef.current = '';
        setOutput('');
        setShowLog(true);
      } else if (msg.event === 'output') {
        outputRef.current += msg.text;
        setOutput(outputRef.current);
      } else if (msg.event === 'done') {
        setRunning(false);
        setExitCode(msg.code);
        qc.invalidateQueries({ queryKey: ['plan'] });
      }
    };

    return () => es.close();
  }, [qc]);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [output]);

  const startDryRun = () =>
    fetch('/api/run/dry-run', { method: 'POST' }).catch(() => {});

  const startExecute = () =>
    fetch('/api/run/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flags }),
    }).catch(() => {});

  const cancel = () =>
    fetch('/api/run/cancel', { method: 'POST' }).catch(() => {});

  const toggleFlag = (key) =>
    setFlags(prev => ({ ...prev, [key]: !prev[key] }));

  const saveDupFolder = () =>
    updateSettings.mutate({ duplicatesFolder: dupFolderInput.trim() || null });

  const activeFlags = FLAG_DEFS.filter(f => flags[f.key]).map(f => f.label);

  const statusColor = exitCode == null ? 'var(--color-muted)'
    : exitCode === 0 ? 'var(--color-success)' : 'var(--color-danger)';

  return (
    <div style={{
      background: 'var(--color-surface-2)',
      borderBottom: '1px solid var(--color-border)',
    }}>
      {/* Controls row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px' }}>

        {/* Dry run */}
        <button
          className="btn btn-primary"
          onClick={startDryRun}
          disabled={running}
          title="Regenerate plan.json from the audiobooks directory"
        >
          {running && runType === 'dry-run'
            ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            : <Play size={12} />}
          Dry Run
        </button>

        {/* Execute */}
        <button
          className="btn btn-warning"
          onClick={startExecute}
          disabled={running}
          title="Apply the plan — move and delete files"
        >
          {running && runType === 'execute'
            ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            : <Play size={12} />}
          Execute
        </button>

        {/* Flag options toggle */}
        <button
          className="btn btn-ghost"
          onClick={() => setShowFlags(v => !v)}
          title="Configure execute flags"
          style={{ gap: 4 }}
        >
          Options
          {showFlags ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {activeFlags.length > 0 && (
            <span style={{
              background: 'var(--color-accent)', color: '#fff', borderRadius: 8,
              fontSize: 10, padding: '1px 5px', marginLeft: 2,
            }}>
              {activeFlags.length}
            </span>
          )}
        </button>

        {/* Running status */}
        {running ? (
          <span style={{ color: 'var(--color-warning)', fontSize: 12, marginLeft: 4 }}>
            Running {runType}…
          </span>
        ) : exitCode != null ? (
          <span style={{ color: statusColor, fontSize: 12, marginLeft: 4 }}>
            {runType} {exitCode === 0 ? 'completed' : `failed (exit ${exitCode})`}
          </span>
        ) : null}

        {/* Cancel */}
        {running && (
          <button className="btn btn-danger" onClick={cancel} style={{ marginLeft: 4 }}>
            <Square size={11} /> Cancel
          </button>
        )}

        {/* Log toggle */}
        <button
          className="btn btn-ghost"
          onClick={() => setShowLog(v => !v)}
          style={{ marginLeft: 'auto' }}
        >
          <Terminal size={12} />
          {showLog ? 'Hide Log' : 'Show Log'}
        </button>
      </div>

      {/* Execute flag options */}
      {showFlags && (
        <div style={{
          padding: '8px 16px 12px',
          borderTop: '1px solid var(--color-border)',
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', marginBottom: 12 }}>
            {FLAG_DEFS.map(({ key, label, desc }) => (
              <label key={key}
                style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                title={desc}
              >
                <input
                  type="checkbox"
                  checked={flags[key]}
                  onChange={() => toggleFlag(key)}
                  style={{ accentColor: 'var(--color-accent)', cursor: 'pointer' }}
                />
                <code style={{ fontSize: 11, color: flags[key] ? 'var(--color-text)' : 'var(--color-muted)' }}>
                  {label}
                </code>
              </label>
            ))}
          </div>
          <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--color-muted)', whiteSpace: 'nowrap' }}>
              Duplicates folder:
            </span>
            <input
              type="text"
              value={dupFolderInput}
              onChange={e => setDupFolderInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveDupFolder()}
              placeholder="(leave blank to delete duplicates)"
              style={{
                flex: 1, minWidth: 260,
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                borderRadius: 4, padding: '3px 8px', fontSize: 12,
                color: 'var(--color-text)', fontFamily: 'monospace',
              }}
            />
            <button
              className="btn btn-ghost"
              onClick={saveDupFolder}
              disabled={updateSettings.isPending}
              style={{ fontSize: 11, padding: '3px 10px' }}
            >
              {updateSettings.isPending ? 'Saving…' : 'Save'}
            </button>
            {plan?.settings?.duplicatesFolder && (
              <span style={{ fontSize: 11, color: 'var(--color-success)' }}>
                ✓ Resolved duplicates will be moved, not deleted
              </span>
            )}
          </div>
        </div>
      )}

      {/* Output log */}
      {showLog && (
        <div
          ref={logRef}
          style={{
            borderTop: '1px solid var(--color-border)',
            background: '#0a0c12',
            height: 220,
            overflow: 'auto',
            padding: '10px 14px',
          }}
        >
          {output ? (
            <pre style={{
              margin: 0, fontFamily: 'monospace', fontSize: 12,
              lineHeight: 1.55, color: '#d4d4d4', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {output}
            </pre>
          ) : (
            <span style={{ color: 'var(--color-muted)', fontSize: 12, fontFamily: 'monospace' }}>
              No output yet — start a run above.
            </span>
          )}
          {running && (
            <span style={{ color: 'var(--color-warning)', fontFamily: 'monospace', fontSize: 12 }}>
              ▋
            </span>
          )}
        </div>
      )}
    </div>
  );
}
