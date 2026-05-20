import React, { useState, useEffect, useRef } from 'react';
import { FolderOpen, ArrowUp, ChevronRight, X } from 'lucide-react';

export default function FolderBrowser({ initialPath, onSelect, onClose }) {
  const [currentPath, setCurrentPath] = useState(() => initialPath || '/');
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/fs/ls?path=${encodeURIComponent(currentPath)}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setError(data.error); setEntries([]); }
        else setEntries(data.entries.filter(e => e.isDir));
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [currentPath]);

  // Scroll list to top when path changes
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [currentPath]);

  const goUp = () => {
    const parts = currentPath.replace(/\/$/, '').split('/');
    parts.pop();
    setCurrentPath(parts.join('/') || '/');
  };

  const atRoot = currentPath === '/' || currentPath === '';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          width: 540, maxWidth: '90vw',
          display: 'flex', flexDirection: 'column',
          maxHeight: '80vh',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid var(--color-border)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
            Browse for folder
          </span>
          <button
            className="btn btn-ghost"
            onClick={onClose}
            style={{ padding: '2px 6px' }}
          >
            <X size={13} />
          </button>
        </div>

        {/* Current path + Up */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
        }}>
          <button
            className="btn btn-ghost"
            onClick={goUp}
            disabled={atRoot}
            style={{ padding: '2px 8px', fontSize: 11 }}
            title="Go to parent directory"
          >
            <ArrowUp size={12} /> Up
          </button>
          <code style={{
            fontSize: 12, color: 'var(--color-text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            flex: 1,
          }}>
            {currentPath}
          </code>
        </div>

        {/* Directory listing */}
        <div
          ref={listRef}
          style={{
            flex: 1, overflowY: 'auto',
            minHeight: 0,
          }}
        >
          {loading && (
            <div style={{ padding: '20px 14px', color: 'var(--color-muted)', fontSize: 13 }}>
              Loading…
            </div>
          )}
          {!loading && error && (
            <div style={{ padding: '12px 14px', color: 'var(--color-danger)', fontSize: 12 }}>
              {error}
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div style={{ padding: '20px 14px', color: 'var(--color-muted)', fontSize: 13 }}>
              No subdirectories
            </div>
          )}
          {!loading && entries.map(e => (
            <button
              key={e.path}
              onClick={() => setCurrentPath(e.path)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', textAlign: 'left',
                padding: '7px 14px',
                background: 'none', border: 'none',
                borderBottom: '1px solid var(--color-border)',
                color: 'var(--color-text)',
                cursor: 'pointer', fontSize: 13,
              }}
              onMouseEnter={ev => ev.currentTarget.style.background = 'var(--color-surface)'}
              onMouseLeave={ev => ev.currentTarget.style.background = 'none'}
            >
              <FolderOpen size={13} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                {e.name}
              </span>
              <ChevronRight size={12} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
            </button>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '10px 14px',
          borderTop: '1px solid var(--color-border)',
        }}>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => { onSelect(currentPath); onClose(); }}
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
