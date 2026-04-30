import React, { useState, useEffect } from 'react';
import { FolderOpen, ChevronRight, X, Check } from 'lucide-react';
import { useUpdateItem } from '../hooks/usePlan.js';

export default function BestGuessModal({ item, onClose }) {
  const [dest, setDest] = useState(item.dest || item.fallbackDest || '');
  const [browsePath, setBrowsePath] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const update = useUpdateItem();

  useEffect(() => {
    if (browsePath === null) return;
    setLoadingEntries(true);
    fetch(`/api/fs/ls?path=${encodeURIComponent(browsePath)}`)
      .then(r => r.json())
      .then(data => setEntries(data.entries || []))
      .catch(() => setEntries([]))
      .finally(() => setLoadingEntries(false));
  }, [browsePath]);

  const confirm = () => {
    update.mutate(
      { id: item.id, patch: { dest, bestGuess: false, status: 'approved' } },
      { onSuccess: onClose }
    );
  };

  const selectEntry = (entry) => {
    if (entry.isDir) {
      setBrowsePath(entry.path);
      setDest(entry.path);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: 'var(--color-surface)', border: '1px solid var(--color-border)',
        borderRadius: 12, width: 620, maxWidth: '90vw', maxHeight: '80vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Edit Destination</span>
          <button className="btn btn-ghost" onClick={onClose}><X size={14} /></button>
        </div>

        {/* Source */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface-2)' }}>
          <div style={{ color: 'var(--color-muted)', fontSize: 11, marginBottom: 4 }}>SOURCE</div>
          <code className="path-text-bright" style={{ display: 'block', wordBreak: 'break-all' }}>{item.source}</code>
          {item.bestGuessNote && (
            <div style={{ color: 'var(--color-warning)', fontSize: 12, marginTop: 6 }}>
              ⚠ {item.bestGuessNote}
            </div>
          )}
        </div>

        {/* Destination input */}
        <div style={{ padding: '12px 20px' }}>
          <div style={{ color: 'var(--color-muted)', fontSize: 11, marginBottom: 6 }}>DESTINATION PATH</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={dest}
              onChange={e => setDest(e.target.value)}
              style={{
                flex: 1, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
                borderRadius: 6, padding: '6px 10px', color: 'var(--color-text)',
                fontFamily: 'monospace', fontSize: 12,
              }}
            />
            <button
              className="btn btn-ghost"
              title="Browse from this path"
              onClick={() => setBrowsePath(dest || '/')}
            >
              <FolderOpen size={14} />
            </button>
          </div>

          {/* Quick options */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {item.dest && (
              <button className="btn btn-ghost" style={{ fontSize: 11 }}
                onClick={() => setDest(item.dest)}>
                Use guess
              </button>
            )}
            {item.fallbackDest && (
              <button className="btn btn-ghost" style={{ fontSize: 11 }}
                onClick={() => setDest(item.fallbackDest)}>
                Use _NeedsReview
              </button>
            )}
          </div>
        </div>

        {/* Directory browser */}
        {browsePath !== null && (
          <div style={{ flex: 1, overflow: 'auto', padding: '0 20px 12px', borderTop: '1px solid var(--color-border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 0 6px', color: 'var(--color-muted)', fontSize: 11 }}>
              <code style={{ fontSize: 11 }}>{browsePath}</code>
            </div>
            {loadingEntries ? (
              <div style={{ color: 'var(--color-muted)', padding: '8px 0' }}>Loading...</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {entries.length === 0 && (
                  <div style={{ color: 'var(--color-muted)', fontSize: 12 }}>Empty directory</div>
                )}
                {entries.map(e => (
                  <button key={e.path}
                    onClick={() => selectEntry(e)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
                      background: 'transparent', border: 'none', borderRadius: 4,
                      cursor: 'pointer', textAlign: 'left', color: e.isDir ? 'var(--color-accent-hover)' : 'var(--color-muted)',
                    }}
                    onMouseEnter={ev => ev.currentTarget.style.background = 'var(--color-surface-2)'}
                    onMouseLeave={ev => ev.currentTarget.style.background = 'transparent'}
                  >
                    {e.isDir ? <FolderOpen size={13} /> : <ChevronRight size={13} />}
                    <code style={{ fontSize: 12 }}>{e.name}</code>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={confirm} disabled={!dest || update.isPending}>
            <Check size={13} /> Confirm Destination
          </button>
        </div>
      </div>
    </div>
  );
}
