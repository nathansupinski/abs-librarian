import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  FolderOpen, ArrowUp, ChevronRight, X, Home, HardDrive,
  CornerDownLeft, Eye, EyeOff, RefreshCw, Star,
} from 'lucide-react';

// Normalise a user-typed path: trim, collapse repeated slashes, drop
// trailing slash (except for "/"). Leaves the value otherwise untouched
// so absolute / relative semantics are preserved by the server.
function normalisePath(p) {
  if (!p) return '/';
  const trimmed = p.trim();
  if (!trimmed) return '/';
  const collapsed = trimmed.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.slice(0, -1);
  return collapsed;
}

function splitSegments(p) {
  if (!p || p === '/') return [];
  const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed ? trimmed.split('/') : [];
}

export default function FolderBrowser({ initialPath, onSelect, onClose }) {
  const [currentPath, setCurrentPath] = useState(() => normalisePath(initialPath || '/'));
  // What the user has typed but not yet committed. Synced from currentPath
  // on navigation; committed on Enter or blur.
  const [pathInput, setPathInput] = useState(() => normalisePath(initialPath || '/'));
  const [entries, setEntries] = useState([]);
  const [parent, setParent] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [shortcuts, setShortcuts] = useState([]);
  const [focusIndex, setFocusIndex] = useState(-1);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  // Load shortcuts once.
  useEffect(() => {
    fetch('/api/fs/shortcuts')
      .then(r => r.json())
      .then(data => setShortcuts(data.shortcuts || []))
      .catch(() => setShortcuts([]));
  }, []);

  // Load directory listing whenever currentPath changes.
  const loadDir = useCallback((p) => {
    setLoading(true);
    setError(null);
    fetch(`/api/fs/ls?path=${encodeURIComponent(p)}`)
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Failed (${r.status})`);
        return data;
      })
      .then(data => {
        setEntries((data.entries || []).filter(e => e.isDir));
        setParent(data.parent ?? null);
        setLoading(false);
        setFocusIndex(-1);
      })
      .catch(e => { setError(e.message); setEntries([]); setLoading(false); });
  }, []);

  useEffect(() => { loadDir(currentPath); }, [currentPath, loadDir]);

  // Sync the input field to currentPath when it changes (only if user
  // isn't actively editing — checked via focus state).
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setPathInput(currentPath);
    }
  }, [currentPath]);

  // Scroll list to top on navigation.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [currentPath]);

  const navigate = useCallback((p) => {
    const np = normalisePath(p);
    setCurrentPath(np);
    setPathInput(np);
  }, []);

  const visibleEntries = useMemo(
    () => showHidden ? entries : entries.filter(e => !e.name.startsWith('.')),
    [entries, showHidden]
  );

  const segments = useMemo(() => splitSegments(currentPath), [currentPath]);

  const commitInput = () => {
    if (pathInput && pathInput !== currentPath) navigate(pathInput);
  };

  const goUp = () => {
    if (parent) navigate(parent);
  };

  const handleListKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex(i => Math.min(visibleEntries.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && focusIndex >= 0 && focusIndex < visibleEntries.length) {
      e.preventDefault();
      navigate(visibleEntries[focusIndex].path);
    } else if (e.key === 'Backspace' && parent) {
      e.preventDefault();
      goUp();
    }
  };

  // Auto-focus path input on mount.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

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
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        style={{
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          width: 820, maxWidth: '95vw',
          height: 560, maxHeight: '85vh',
          display: 'flex', flexDirection: 'column',
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
            title="Close (Esc)"
          >
            <X size={13} />
          </button>
        </div>

        {/* Path input row + actions */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 14px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
        }}>
          <button
            className="btn btn-ghost"
            onClick={goUp}
            disabled={!parent}
            style={{ padding: '3px 8px', fontSize: 11 }}
            title="Go to parent directory (Backspace)"
          >
            <ArrowUp size={12} />
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => loadDir(currentPath)}
            style={{ padding: '3px 8px', fontSize: 11 }}
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
          <input
            ref={inputRef}
            type="text"
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitInput(); }
              else if (e.key === 'Escape') { e.preventDefault(); setPathInput(currentPath); }
            }}
            onBlur={commitInput}
            spellCheck={false}
            style={{
              flex: 1, minWidth: 0,
              background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: 12,
              fontFamily: 'monospace',
              color: 'var(--color-text)',
            }}
            placeholder="/path/to/folder — Enter to navigate"
          />
          <button
            className="btn btn-ghost"
            onClick={commitInput}
            style={{ padding: '3px 8px', fontSize: 11 }}
            title="Navigate to typed path"
          >
            <CornerDownLeft size={12} />
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => setShowHidden(v => !v)}
            style={{ padding: '3px 8px', fontSize: 11 }}
            title={showHidden ? 'Hide hidden directories' : 'Show hidden directories'}
          >
            {showHidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>

        {/* Breadcrumbs */}
        <div style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap',
          gap: 2,
          padding: '6px 14px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          fontSize: 11,
        }}>
          <button
            className="btn btn-ghost"
            onClick={() => navigate('/')}
            style={{ padding: '1px 6px', fontSize: 11 }}
            title="Filesystem root"
          >
            /
          </button>
          {segments.map((seg, i) => {
            const segPath = '/' + segments.slice(0, i + 1).join('/');
            const isLast = i === segments.length - 1;
            return (
              <React.Fragment key={segPath}>
                <ChevronRight size={11} style={{ color: 'var(--color-muted)' }} />
                <button
                  className="btn btn-ghost"
                  onClick={() => navigate(segPath)}
                  style={{
                    padding: '1px 6px',
                    fontSize: 11,
                    fontWeight: isLast ? 600 : 400,
                    color: isLast ? 'var(--color-text)' : 'var(--color-muted)',
                  }}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Body: shortcuts sidebar + listing */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Shortcuts sidebar */}
          <div style={{
            width: 180,
            borderRight: '1px solid var(--color-border)',
            overflowY: 'auto',
            background: 'var(--color-surface)',
            padding: '6px 0',
          }}>
            <div style={{
              padding: '4px 12px',
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              color: 'var(--color-muted)',
              letterSpacing: 0.5,
            }}>
              Shortcuts
            </div>
            {shortcuts.length === 0 && (
              <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--color-muted)' }}>
                None available
              </div>
            )}
            {shortcuts.map(sc => {
              const Icon = sc.kind === 'plan' ? Star
                         : sc.label === 'Home' ? Home
                         : HardDrive;
              const active = currentPath === sc.path;
              return (
                <button
                  key={sc.path}
                  onClick={() => navigate(sc.path)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', textAlign: 'left',
                    padding: '5px 12px',
                    background: active ? 'var(--color-surface-2)' : 'none',
                    border: 'none', borderLeft: active ? '2px solid var(--color-accent)' : '2px solid transparent',
                    color: 'var(--color-text)',
                    cursor: 'pointer', fontSize: 12,
                  }}
                  onMouseEnter={ev => { if (!active) ev.currentTarget.style.background = 'var(--color-surface-2)'; }}
                  onMouseLeave={ev => { if (!active) ev.currentTarget.style.background = 'none'; }}
                  title={sc.path}
                >
                  <Icon size={12} style={{ color: sc.kind === 'plan' ? 'var(--color-accent)' : 'var(--color-muted)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sc.label}
                    </div>
                    <div style={{
                      fontSize: 10, color: 'var(--color-muted)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontFamily: 'monospace',
                    }}>
                      {sc.path}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Directory listing */}
          <div
            ref={listRef}
            tabIndex={0}
            onKeyDown={handleListKeyDown}
            style={{
              flex: 1, overflowY: 'auto',
              minHeight: 0,
              outline: 'none',
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
            {!loading && !error && visibleEntries.length === 0 && (
              <div style={{ padding: '20px 14px', color: 'var(--color-muted)', fontSize: 13 }}>
                {entries.length > 0
                  ? `No visible subdirectories (${entries.length} hidden)`
                  : 'No subdirectories'}
              </div>
            )}
            {!loading && visibleEntries.map((e, i) => {
              const focused = i === focusIndex;
              return (
                <button
                  key={e.path}
                  onClick={() => navigate(e.path)}
                  onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--color-surface)'; setFocusIndex(i); }}
                  onMouseLeave={ev => { ev.currentTarget.style.background = focused ? 'var(--color-surface)' : 'none'; }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', textAlign: 'left',
                    padding: '7px 14px',
                    background: focused ? 'var(--color-surface)' : 'none',
                    border: 'none',
                    borderLeft: focused ? '2px solid var(--color-accent)' : '2px solid transparent',
                    borderBottom: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                    cursor: 'pointer', fontSize: 13,
                  }}
                >
                  <FolderOpen size={13} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                    {e.name}
                  </span>
                  <ChevronRight size={12} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          padding: '10px 14px',
          borderTop: '1px solid var(--color-border)',
        }}>
          <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>
            {visibleEntries.length} {visibleEntries.length === 1 ? 'folder' : 'folders'}
            {!showHidden && entries.length > visibleEntries.length && (
              <> · {entries.length - visibleEntries.length} hidden</>
            )}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => { onSelect(currentPath); onClose(); }}
              disabled={!!error}
              title={error ? 'Cannot select an invalid path' : 'Select this folder'}
            >
              Select this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
