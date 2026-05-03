import React, { useState, useEffect } from 'react';
import { X, Search, BookOpen } from 'lucide-react';
import { usePatchItemsBatch, useSeriesSuggest } from '../hooks/usePlan.js';

// ── Title cleanup (mirrors src/core/title-utils.mjs for browser use) ─────────

function cleanBookTitle(name) {
  let t = (name || '').trim();
  t = t.replace(/\s*[-_:]\s*.+?,\s*Book\s+\d+(?:\.\d+)?.*$/i, '');
  t = t.replace(/\s*[-_:]\s*Book\s+\d+(?:\.\d+)?.*$/i, '');
  t = t.replace(/\s*[\[(][^\])]*(Book\s+\d+|#\s*\d+)[^\])]*[\])]\s*$/i, '');
  return t.trim() || name;
}

// ── Path helpers (no Node.js path module in the browser) ─────────────────────

function pathBasename(p) {
  const clean = p.endsWith('/') ? p.slice(0, -1) : p;
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function pathDirname(p) {
  const clean = p.endsWith('/') ? p.slice(0, -1) : p;
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? '' : clean.slice(0, idx);
}

function getAuthorName(item, root) {
  const rel = item.source.startsWith(root + '/')
    ? item.source.slice(root.length + 1)
    : item.source;
  return rel.split('/').filter(Boolean)[0] || '';
}

function getBookName(item) {
  return item.type === 'MOVE_DIR'
    ? pathBasename(item.source)
    : pathBasename(pathDirname(item.source));
}

function buildNewDest(item, root, author, seriesName, sequence) {
  const bookName = getBookName(item);
  const seqStr = sequence ? `${sequence} - ` : '';
  const newBookDir = `${seqStr}${bookName}`;
  if (item.type === 'MOVE_DIR') {
    return `${root}/${author}/${seriesName}/${newBookDir}`;
  }
  return `${root}/${author}/${seriesName}/${newBookDir}/${pathBasename(item.source)}`;
}

function buildClearedDest(item, root, author) {
  const bookName = getBookName(item);
  if (item.type === 'MOVE_DIR') return `${root}/${author}/${bookName}`;
  return `${root}/${author}/${bookName}/${pathBasename(item.source)}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SeriesModal({ items, groupLabel, allItems, root, onClose }) {
  const firstItem = items[0];
  const authorName = getAuthorName(firstItem, root);
  const bookName = getBookName(firstItem);
  const currentSeries = firstItem?.series ?? null;

  const [selected, setSelected] = useState(currentSeries);
  const [customSequence, setCustomSequence] = useState(currentSeries?.sequence ?? '');
  const [searchQuery, setSearchQuery] = useState(cleanBookTitle(bookName));
  const [searchResult, setSearchResult] = useState(null);

  const patchBatch = usePatchItemsBatch();
  const suggest = useSeriesSuggest();

  // Unique series already known for this author (from all plan items)
  const authorPrefix = root + '/' + authorName + '/';
  const existingSeries = [...new Set(
    allItems
      .filter(i => i.source.startsWith(authorPrefix) && i.series?.name)
      .map(i => i.series.name)
  )].filter(name => name !== selected?.name);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSearch = async () => {
    setSearchResult(null);
    const result = await suggest.mutateAsync({ title: searchQuery, author: authorName })
      .catch(() => null);
    setSearchResult(result);
  };

  const selectSeries = (name, seq = null) => {
    setSelected({ name, sequence: seq });
    setCustomSequence(seq ?? '');
    setSearchResult(null);
  };

  const handleApply = () => {
    if (!selected) return;
    const seriesObj = { name: selected.name, sequence: customSequence || null };
    const patches = items.map(item => ({
      id: item.id,
      patch: {
        series: seriesObj,
        dest: buildNewDest(item, root, authorName, seriesObj.name, seriesObj.sequence),
      },
    }));
    patchBatch.mutate(patches, { onSuccess: onClose });
  };

  const handleClear = () => {
    const patches = items.map(item => ({
      id: item.id,
      patch: { series: null, dest: buildClearedDest(item, root, authorName) },
    }));
    patchBatch.mutate(patches, { onSuccess: onClose });
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--color-surface)', border: '1px solid var(--color-border)',
        borderRadius: 10, padding: 24, width: 480, maxWidth: '95vw',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BookOpen size={16} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
          <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>Edit Series</span>
          <code style={{ fontSize: 11, color: 'var(--color-muted)', flex: 2 }}>{groupLabel}</code>
          <button className="btn btn-ghost" style={{ padding: '2px 6px' }} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Current series */}
        {currentSeries && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
            background: 'var(--color-surface-2)', borderRadius: 6, fontSize: 12 }}>
            <span style={{ color: 'var(--color-muted)' }}>Current:</span>
            <span className="badge badge-series">
              {currentSeries.name}{currentSeries.sequence ? ` #${currentSeries.sequence}` : ''}
            </span>
            <button className="btn btn-ghost" style={{ fontSize: 11, marginLeft: 'auto' }} onClick={handleClear}
              disabled={patchBatch.isPending}>
              Clear series
            </button>
          </div>
        )}

        {/* Selected preview */}
        {selected && selected.name !== currentSeries?.name && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
            background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)',
            borderRadius: 6, fontSize: 12 }}>
            <span style={{ color: 'var(--color-muted)' }}>Selected:</span>
            <span className="badge badge-series">
              {selected.name}{customSequence ? ` #${customSequence}` : ''}
            </span>
          </div>
        )}

        {/* Author's existing series */}
        {existingSeries.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 6 }}>
              Other series by {authorName}:
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {existingSeries.map(name => (
                <button key={name} className="badge badge-series"
                  style={{ background: selected?.name === name ? '#4c2a7a' : undefined }}
                  onClick={() => selectSeries(name)}>
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Search */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 6 }}>
            Search for series:
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
              placeholder="Book title or series name…"
              style={{
                flex: 1, padding: '6px 10px', borderRadius: 6, fontSize: 12,
                background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
                color: 'var(--color-text)', outline: 'none',
              }}
            />
            <button className="btn btn-ghost" onClick={handleSearch} disabled={suggest.isPending}>
              <Search size={13} />
              {suggest.isPending ? 'Searching…' : 'Search'}
            </button>
          </div>

          {suggest.isError && (
            <div style={{ color: 'var(--color-danger)', fontSize: 11, marginTop: 6 }}>
              Search failed — check server connection
            </div>
          )}

          {searchResult === null && suggest.isSuccess && (
            <div style={{ color: 'var(--color-muted)', fontSize: 11, marginTop: 6 }}>
              No series found for this title
            </div>
          )}

          {searchResult && (
            <div style={{
              marginTop: 8, padding: '10px 12px', borderRadius: 6,
              background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 6 }}>
                {searchResult.provider} · {Math.round(searchResult.confidence * 100)}% confidence
                {searchResult.bookTitle && ` · "${searchResult.bookTitle}"`}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {searchResult.series.map((s, i) => (
                  <button key={i} className="badge badge-series"
                    style={{ background: selected?.name === s.series ? '#4c2a7a' : undefined }}
                    onClick={() => selectSeries(s.series, s.sequence ? String(s.sequence) : null)}>
                    {s.series}{s.sequence ? ` #${s.sequence}` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sequence override */}
        {selected && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--color-muted)', flexShrink: 0 }}>
              Book # in series:
            </label>
            <input
              type="text"
              value={customSequence}
              onChange={e => setCustomSequence(e.target.value)}
              placeholder="e.g. 01, 2.5 (optional)"
              style={{
                width: 140, padding: '5px 8px', borderRadius: 6, fontSize: 12,
                background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
                color: 'var(--color-text)', outline: 'none',
              }}
            />
          </div>
        )}

        {/* New dest preview */}
        {selected && (
          <div style={{ fontSize: 11, color: 'var(--color-muted)', padding: '6px 10px',
            background: 'var(--color-surface-2)', borderRadius: 6 }}>
            <span style={{ color: 'var(--color-muted)' }}>New dest: </span>
            <code style={{ color: 'var(--color-text)', wordBreak: 'break-all' }}>
              {buildNewDest(firstItem, root, authorName, selected.name, customSequence || null)
                .replace(root + '/', '')}
            </code>
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-success" onClick={handleApply}
            disabled={!selected || patchBatch.isPending}>
            {patchBatch.isPending ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
