import React, { useState } from 'react';
import { Star, Loader2, AlertTriangle } from 'lucide-react';
import { useResolveConflict, useUndoConflict, useConflictMeta } from '../hooks/usePlan.js';

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function formatDuration(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
               : `${m}:${String(s).padStart(2,'0')}`;
}

function MetaRow({ label, vNew, vExisting, recommended, better }) {
  const star = (side) => recommended === side && better ? (
    <Star size={11} style={{ color: 'var(--color-warning)', marginLeft: 3, flexShrink: 0 }} fill="currentColor" />
  ) : null;

  return (
    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
      <td style={{ padding: '4px 8px', color: 'var(--color-muted)', fontSize: 11, width: 80 }}>{label}</td>
      <td style={{
        padding: '4px 8px', fontSize: 12, fontFamily: 'monospace',
        color: recommended === 'new' && better ? 'var(--color-success)' : 'var(--color-text)',
      }}>
        <span style={{ display: 'flex', alignItems: 'center' }}>{vNew ?? '—'}{star('new')}</span>
      </td>
      <td style={{
        padding: '4px 8px', fontSize: 12, fontFamily: 'monospace',
        color: recommended === 'existing' && better ? 'var(--color-success)' : 'var(--color-text)',
      }}>
        <span style={{ display: 'flex', alignItems: 'center' }}>{vExisting ?? '—'}{star('existing')}</span>
      </td>
    </tr>
  );
}

function MetaTable({ sourceMeta, libraryMeta, recommendation }) {
  const diff = (k) => sourceMeta[k] !== libraryMeta[k] && sourceMeta[k] != null && libraryMeta[k] != null;

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
          <th style={{ padding: '4px 8px', color: 'var(--color-muted)', fontSize: 11, textAlign: 'left', width: 80 }} />
          <th style={{ padding: '4px 8px', color: recommendation === 'new' ? 'var(--color-success)' : 'var(--color-text)', fontSize: 11, textAlign: 'left' }}>
            Ingested (new) {recommendation === 'new' && '★'}
          </th>
          <th style={{ padding: '4px 8px', color: recommendation === 'existing' ? 'var(--color-success)' : 'var(--color-text)', fontSize: 11, textAlign: 'left' }}>
            In Library {recommendation === 'existing' && '★'}
          </th>
        </tr>
      </thead>
      <tbody>
        <MetaRow label="Size"     vNew={formatSize(sourceMeta.size)}                              vExisting={formatSize(libraryMeta.size)}                              recommended={recommendation} better={diff('size')} />
        <MetaRow label="Bitrate"  vNew={sourceMeta.bitrate ? `${sourceMeta.bitrate} kbps` : '—'} vExisting={libraryMeta.bitrate ? `${libraryMeta.bitrate} kbps` : '—'} recommended={recommendation} better={diff('bitrate')} />
        <MetaRow label="Duration" vNew={formatDuration(sourceMeta.duration)}                      vExisting={formatDuration(libraryMeta.duration)}                      recommended={recommendation} better={diff('duration')} />
        <MetaRow label="Codec"    vNew={sourceMeta.codec}                                          vExisting={libraryMeta.codec}                                          recommended={null} better={false} />
        <MetaRow label="Title"    vNew={sourceMeta.title}                                          vExisting={libraryMeta.title}                                          recommended={null} better={false} />
        <MetaRow label="Artist"   vNew={sourceMeta.artist}                                         vExisting={libraryMeta.artist}                                         recommended={null} better={false} />
        <MetaRow label="Album"    vNew={sourceMeta.album}                                          vExisting={libraryMeta.album}                                          recommended={null} better={false} />
        <MetaRow label="Year"     vNew={sourceMeta.year}                                           vExisting={libraryMeta.year}                                           recommended={null} better={false} />
      </tbody>
    </table>
  );
}

export default function ConflictCard({ conflict, index, sourceRoot, libraryRoot, duplicatesFolder }) {
  const [loadMeta, setLoadMeta] = useState(false);
  const resolve = useResolveConflict();
  const undo    = useUndoConflict();

  const hasMeta = conflict.sourceMeta && conflict.libraryMeta;
  const { data: fetchedMeta, isFetching } = useConflictMeta(index, loadMeta && !hasMeta);

  const sourceMeta  = conflict.sourceMeta  || fetchedMeta?.sourceMeta;
  const libraryMeta = conflict.libraryMeta || fetchedMeta?.libraryMeta;
  const recommendation = conflict.recommendation ?? fetchedMeta?.recommendation ?? null;

  const shorten = (p, root) => root && p?.startsWith(root + '/') ? p.slice(root.length + 1) : p;

  const matchLabel = conflict.matchType === 'path'
    ? 'destination already exists'
    : 'content match in library (same artist + album)';

  const pickKeep = (which) => resolve.mutate({ index, keep: which });
  const resolved = !!conflict.resolution;
  const dismissed = !!conflict.dismissed;

  return (
    <div className="surface" style={{ marginBottom: 12, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ background: '#2a1f33', color: '#c084fc', fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
          <AlertTriangle size={11} /> Conflict
        </span>
        <span style={{ color: 'var(--color-muted)', fontSize: 12 }}>{matchLabel}</span>
        {resolved && (
          <span style={{ marginLeft: 'auto', color: 'var(--color-success)', fontSize: 11 }}>
            ✓ Keeping {conflict.resolution.keep === 'new' ? 'ingested copy' : 'existing copy'}
          </span>
        )}
        {dismissed && !resolved && (
          <span style={{ marginLeft: 'auto', color: 'var(--color-muted)', fontSize: 11 }}>
            ✗ Not actually a conflict — will move into library
          </span>
        )}
      </div>

      {/* File paths */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{
          padding: '8px 12px',
          borderRight: '1px solid var(--color-border)',
          background: conflict.resolution?.keep === 'new' ? 'color-mix(in srgb, var(--color-success) 6%, transparent)' : 'transparent',
        }}>
          <div style={{ color: 'var(--color-muted)', fontSize: 10, marginBottom: 3 }}>INGESTED (NEW)</div>
          <code className="path-text" title={conflict.source} style={{ display: 'block', color: 'var(--color-text)' }}>
            {shorten(conflict.source, sourceRoot)}
          </code>
          <div style={{ color: 'var(--color-muted)', fontSize: 10, marginTop: 6 }}>WOULD MOVE TO</div>
          <code className="path-text" title={conflict.dest} style={{ display: 'block', color: 'var(--color-muted)', fontSize: 11 }}>
            {shorten(conflict.dest, libraryRoot)}
          </code>
        </div>
        <div style={{
          padding: '8px 12px',
          background: conflict.resolution?.keep === 'existing' ? 'color-mix(in srgb, var(--color-success) 6%, transparent)' : 'transparent',
        }}>
          <div style={{ color: 'var(--color-muted)', fontSize: 10, marginBottom: 3 }}>IN LIBRARY (EXISTING)</div>
          <code className="path-text" title={conflict.libraryFile} style={{ display: 'block', color: 'var(--color-text)' }}>
            {shorten(conflict.libraryFile, libraryRoot)}
          </code>
        </div>
      </div>

      {/* Metadata */}
      {sourceMeta && libraryMeta ? (
        <MetaTable sourceMeta={sourceMeta} libraryMeta={libraryMeta} recommendation={recommendation} />
      ) : (
        <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          {isFetching ? (
            <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ color: 'var(--color-muted)', fontSize: 12 }}>Loading metadata...</span></>
          ) : (
            <button className="btn btn-ghost" onClick={() => setLoadMeta(true)}>
              Load file metadata
            </button>
          )}
        </div>
      )}

      {/* Recommendation note */}
      {recommendation && (
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--color-border)', background: 'var(--color-surface-2)', fontSize: 11, color: 'var(--color-muted)' }}>
          <Star size={11} style={{ color: 'var(--color-warning)' }} fill="currentColor" />
          {' '}Higher quality: <strong style={{ color: 'var(--color-warning)' }}>{recommendation === 'new' ? 'Ingested' : 'Existing'} copy</strong>
        </div>
      )}

      {/* Actions */}
      <div style={{ padding: '10px 16px', borderTop: '1px solid var(--color-border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        {!resolved && !dismissed ? (
          <>
            <button className="btn btn-success"
              style={{ flex: 1 }}
              onClick={() => pickKeep('new')}
              disabled={resolve.isPending}
              title={duplicatesFolder
                ? `Replace existing library copy. The old file moves to ${duplicatesFolder}.`
                : 'Replace existing library copy. The old file will be deleted (requires --delete-junk on execute).'}>
              {recommendation === 'new' && '★ '}Keep New (replace library copy)
            </button>
            <button className="btn btn-success"
              style={{ flex: 1 }}
              onClick={() => pickKeep('existing')}
              disabled={resolve.isPending}
              title="Keep the library copy. The ingested file stays in the ingestion folder untouched.">
              {recommendation === 'existing' && '★ '}Keep Existing
            </button>
            <button className="btn btn-ghost"
              onClick={() => pickKeep('dismiss')}
              disabled={resolve.isPending}
              title="Not actually a conflict — perform the move anyway.">
              Not a conflict
            </button>
          </>
        ) : (
          <>
            <span style={{ flex: 1, color: 'var(--color-muted)', fontSize: 12 }}>
              {dismissed ? (
                <>Will move ingested file into library; no eviction.</>
              ) : conflict.resolution.keep === 'new' ? (
                duplicatesFolder
                  ? <>Will move existing library file to <code style={{ fontSize: 11 }}>{duplicatesFolder}</code> and move the ingested copy in.</>
                  : <>Will delete existing library file and move the ingested copy in (requires --delete-junk).</>
              ) : (
                <>Ingested file stays at <code style={{ fontSize: 11 }}>{shorten(conflict.source, sourceRoot)}</code>; library unchanged.</>
              )}
            </span>
            <button className="btn btn-ghost"
              onClick={() => undo.mutate(index)}
              disabled={undo.isPending}>
              Undo
            </button>
          </>
        )}
      </div>
    </div>
  );
}
