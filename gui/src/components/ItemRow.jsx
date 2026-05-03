import React, { useState } from 'react';
import { CheckCircle, MinusCircle, ChevronRight, ChevronDown, Edit2, BookOpen } from 'lucide-react';
import { useUpdateItem } from '../hooks/usePlan.js';
import BestGuessModal from './BestGuessModal.jsx';

function Badge({ item }) {
  if (item.bestGuess) return <span className="badge badge-guess">GUESS</span>;
  if (item.junk)      return <span className="badge badge-junk">JUNK</span>;
  if (item.type === 'MOVE_DIR')  return <span className="badge badge-dir">DIR</span>;
  return <span className="badge badge-file">FILE</span>;
}

function ProviderBadge({ providerMatch }) {
  if (!providerMatch) return null;
  const pct = Math.round((providerMatch.confidence ?? 0) * 100);
  const detail = `${providerMatch.title || ''}${providerMatch.author ? ` by ${providerMatch.author}` : ''}`;
  return (
    <span
      className="badge badge-provider"
      title={`${providerMatch.provider}: ${detail} (${pct}%)`}
    >
      <BookOpen size={9} style={{ flexShrink: 0 }} />
      {providerMatch.provider}
    </span>
  );
}

function SeriesBadge({ series }) {
  if (!series) return null;
  const label = series.sequence ? `${series.name} #${series.sequence}` : series.name;
  return (
    <span className="badge badge-series" title={`Series: ${label}`}>
      {label}
    </span>
  );
}

function StatusIcon({ status }) {
  if (status === 'approved') return <CheckCircle size={14} style={{ color: 'var(--color-success)', flexShrink: 0 }} />;
  if (status === 'skipped')  return <MinusCircle size={14} style={{ color: 'var(--color-skip)', flexShrink: 0 }} />;
  return <div style={{ width: 14, flexShrink: 0 }} />;
}

function rel(p, root) {
  if (!p) return null;
  if (root && p.startsWith(root + '/')) return p.slice(root.length + 1);
  return p;
}

// Splits a relative path into { dir, name } so we can show the filename prominently.
function splitPath(p) {
  if (!p) return { dir: '', name: '—' };
  const slash = p.lastIndexOf('/');
  if (slash === -1) return { dir: '', name: p };
  return { dir: p.slice(0, slash + 1), name: p.slice(slash + 1) };
}

// Dim directory prefix + bright filename, truncating the dir if needed.
function PathDisplay({ full, root, color, maxWidth = 340 }) {
  const relative = rel(full, root);
  if (!relative) return <span style={{ color: 'var(--color-muted)', fontFamily: 'monospace', fontSize: 12 }}>—</span>;
  const { dir, name } = splitPath(relative);
  return (
    <span style={{ display: 'flex', alignItems: 'baseline', minWidth: 0, maxWidth, fontFamily: 'monospace', fontSize: 12 }}>
      {dir && (
        <span style={{
          color: 'var(--color-muted)', overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0,
          // Show the tail of the directory so we don't lose context
          direction: 'rtl', unicodeBidi: 'plaintext',
        }}>
          {dir}
        </span>
      )}
      <span style={{ color: color || 'var(--color-text)', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {name}
      </span>
    </span>
  );
}

export default function ItemRow({ item, root, selected, onSelect, allVisibleIds }) {
  const [showModal, setShowModal] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const update = useUpdateItem();

  const approve     = (e) => { e.stopPropagation(); update.mutate({ id: item.id, patch: { status: 'approved' } }); };
  const skip        = (e) => { e.stopPropagation(); update.mutate({ id: item.id, patch: { status: 'skipped'  } }); };
  const acceptGuess = (e) => { e.stopPropagation(); update.mutate({ id: item.id, patch: { status: 'approved', bestGuess: false } }); };
  const useFallback = (e) => { e.stopPropagation(); update.mutate({ id: item.id, patch: { status: 'approved', dest: item.fallbackDest, bestGuess: false } }); };

  const isSkipped  = item.status === 'skipped';
  const isApproved = item.status === 'approved';

  const handleRowClick = (e) => {
    // Don't expand when interacting with controls
    if (e.target.closest('button, input, a')) return;
    setExpanded(v => !v);
  };

  const handleCheck = (e) => {
    e.stopPropagation();
    onSelect(item.id, e.shiftKey, allVisibleIds);
  };

  return (
    <div style={{ borderBottom: '1px solid var(--color-border)', opacity: isSkipped ? 0.45 : 1 }}>
      {/* Main row */}
      <div
        onClick={handleRowClick}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '7px 16px',
          background: selected ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
          cursor: 'pointer', transition: 'background 0.1s',
        }}
        onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--color-surface-2)'; }}
        onMouseLeave={e => { if (!selected) e.currentTarget.style.background = selected ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent'; }}
      >
        <input type="checkbox" checked={selected} onChange={handleCheck}
          style={{ flexShrink: 0, cursor: 'pointer', accentColor: 'var(--color-accent)' }} />

        <StatusIcon status={item.status} />
        <Badge item={item} />
        <ProviderBadge providerMatch={item.providerMatch} />
        <SeriesBadge series={item.series} />

        {/* Expand toggle */}
        <div style={{ flexShrink: 0, color: 'var(--color-border)', width: 14 }}>
          {expanded
            ? <ChevronDown size={12} style={{ color: 'var(--color-muted)' }} />
            : <ChevronRight size={12} style={{ color: 'var(--color-border)' }} />}
        </div>

        {/* Paths */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <PathDisplay full={item.source} root={root} maxWidth={380} />

          {item.bestGuess ? (
            <>
              <ChevronRight size={12} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />
              <PathDisplay full={item.dest} root={root} color="var(--color-warning)" maxWidth={280} />
            </>
          ) : (
            <>
              <ChevronRight size={12} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
              <PathDisplay full={item.dest} root={root} maxWidth={380} />
            </>
          )}
        </div>

        {/* Reason */}
        <span style={{
          color: 'var(--color-muted)', fontSize: 11, flexShrink: 0, maxWidth: 220,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={item.reason}>
          {item.reason}
        </span>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {item.bestGuess ? (
            <>
              <button className="btn btn-success" onClick={acceptGuess} disabled={update.isPending}>✓ Guess</button>
              <button className="btn btn-warning" onClick={useFallback} disabled={update.isPending}>Fallback</button>
              <button className="btn btn-ghost" onClick={e => { e.stopPropagation(); setShowModal(true); }}>
                <Edit2 size={11} /> Edit
              </button>
              <button className="btn btn-danger" onClick={skip} disabled={update.isPending}>Skip</button>
            </>
          ) : item.junk ? (
            <>
              {!isApproved && <button className="btn btn-danger" onClick={approve} disabled={update.isPending}>Delete</button>}
              {!isSkipped  && <button className="btn btn-ghost"  onClick={skip}    disabled={update.isPending}>Skip</button>}
            </>
          ) : (
            <>
              {!isApproved && <button className="btn btn-success" onClick={approve} disabled={update.isPending}>Approve</button>}
              {!isSkipped  && <button className="btn btn-ghost"   onClick={skip}    disabled={update.isPending}>Skip</button>}
            </>
          )}
          {(isApproved || isSkipped) && (
            <button className="btn btn-ghost" style={{ fontSize: 11 }}
              onClick={e => { e.stopPropagation(); update.mutate({ id: item.id, patch: { status: 'pending' } }); }}>
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Expanded full-path detail */}
      {expanded && (
        <div style={{
          padding: '8px 16px 10px 72px',
          background: 'var(--color-surface-2)',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <FullPathRow label="SRC"  path={item.source} />
          {item.dest        && <FullPathRow label="DEST"     path={item.dest}        />}
          {item.fallbackDest && <FullPathRow label="FALLBACK" path={item.fallbackDest} dim />}
          {item.notes && (
            <div style={{ color: 'var(--color-muted)', fontSize: 11, marginTop: 2 }}>{item.notes}</div>
          )}
          {item.providerMatch && (
            <div style={{ color: 'var(--color-muted)', fontSize: 11, marginTop: 2 }}>
              <span style={{ color: '#7dd3fc' }}>{item.providerMatch.provider}</span>
              {': '}
              <strong style={{ color: 'var(--color-text)' }}>"{item.providerMatch.title}"</strong>
              {item.providerMatch.author && ` by ${item.providerMatch.author}`}
              {item.providerMatch.series?.length > 0 && (
                ` — ${item.providerMatch.series[0].series}` +
                (item.providerMatch.series[0].sequence ? ` #${item.providerMatch.series[0].sequence}` : '')
              )}
              {` (${Math.round((item.providerMatch.confidence ?? 0) * 100)}% confidence)`}
            </div>
          )}
        </div>
      )}

      {showModal && <BestGuessModal item={item} onClose={() => setShowModal(false)} />}
    </div>
  );
}

function FullPathRow({ label, path, dim }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--color-muted)', fontSize: 10, fontWeight: 600, width: 56,
        flexShrink: 0, paddingTop: 1, textAlign: 'right', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <code style={{
        fontSize: 12, wordBreak: 'break-all', lineHeight: 1.5,
        color: dim ? 'var(--color-muted)' : 'var(--color-text)',
      }}>
        {path}
      </code>
    </div>
  );
}
