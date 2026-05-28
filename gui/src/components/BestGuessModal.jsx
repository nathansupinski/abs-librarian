import React, { useState } from 'react';
import { FolderOpen, X, Check } from 'lucide-react';
import { useUpdateItem } from '../hooks/usePlan.js';
import FolderBrowser from './FolderBrowser.jsx';

export default function BestGuessModal({ item, onClose }) {
  const [dest, setDest] = useState(item.dest || item.fallbackDest || '');
  const [showBrowser, setShowBrowser] = useState(false);
  const update = useUpdateItem();

  const confirm = () => {
    update.mutate(
      { id: item.id, patch: { dest, bestGuess: false, status: 'approved' } },
      { onSuccess: onClose }
    );
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
              title="Browse for folder"
              onClick={() => setShowBrowser(true)}
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

        {showBrowser && (
          <FolderBrowser
            initialPath={dest || '/'}
            onSelect={p => setDest(p)}
            onClose={() => setShowBrowser(false)}
          />
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
