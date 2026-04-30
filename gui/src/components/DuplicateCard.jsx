import React, { useState } from 'react';
import { Star, Loader2 } from 'lucide-react';
import { useResolveDuplicate, useUndoDuplicate, useDupMeta } from '../hooks/usePlan.js';

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

function MetaRow({ label, v1, v2, recommended, better }) {
  const star = (side) => recommended === side && better ? (
    <Star size={11} style={{ color: 'var(--color-warning)', marginLeft: 3, flexShrink: 0 }} fill="currentColor" />
  ) : null;

  return (
    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
      <td style={{ padding: '4px 8px', color: 'var(--color-muted)', fontSize: 11, width: 70 }}>{label}</td>
      <td style={{
        padding: '4px 8px', fontSize: 12, fontFamily: 'monospace',
        color: recommended === 'f1' && better ? 'var(--color-success)' : 'var(--color-text)',
      }}>
        <span style={{ display: 'flex', alignItems: 'center' }}>{v1 ?? '—'}{star('f1')}</span>
      </td>
      <td style={{
        padding: '4px 8px', fontSize: 12, fontFamily: 'monospace',
        color: recommended === 'f2' && better ? 'var(--color-success)' : 'var(--color-text)',
      }}>
        <span style={{ display: 'flex', alignItems: 'center' }}>{v2 ?? '—'}{star('f2')}</span>
      </td>
    </tr>
  );
}

function MetaTable({ f1Meta, f2Meta, recommendation }) {
  const diff = (k) => f1Meta[k] !== f2Meta[k] && f1Meta[k] != null && f2Meta[k] != null;

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
          <th style={{ padding: '4px 8px', color: 'var(--color-muted)', fontSize: 11, textAlign: 'left', width: 70 }} />
          <th style={{ padding: '4px 8px', color: recommendation === 'f1' ? 'var(--color-success)' : 'var(--color-text)', fontSize: 11, textAlign: 'left' }}>
            File 1 {recommendation === 'f1' && '★'}
          </th>
          <th style={{ padding: '4px 8px', color: recommendation === 'f2' ? 'var(--color-success)' : 'var(--color-text)', fontSize: 11, textAlign: 'left' }}>
            File 2 {recommendation === 'f2' && '★'}
          </th>
        </tr>
      </thead>
      <tbody>
        <MetaRow label="Size"     v1={formatSize(f1Meta.size)}     v2={formatSize(f2Meta.size)}     recommended={recommendation} better={diff('size')} />
        <MetaRow label="Bitrate"  v1={f1Meta.bitrate ? `${f1Meta.bitrate} kbps` : '—'} v2={f2Meta.bitrate ? `${f2Meta.bitrate} kbps` : '—'} recommended={recommendation} better={diff('bitrate')} />
        <MetaRow label="Duration" v1={formatDuration(f1Meta.duration)} v2={formatDuration(f2Meta.duration)} recommended={recommendation} better={diff('duration')} />
        <MetaRow label="Codec"    v1={f1Meta.codec}  v2={f2Meta.codec}  recommended={null} better={false} />
        <MetaRow label="Title"    v1={f1Meta.title}  v2={f2Meta.title}  recommended={null} better={false} />
        <MetaRow label="Artist"   v1={f1Meta.artist} v2={f2Meta.artist} recommended={null} better={false} />
        <MetaRow label="Album"    v1={f1Meta.album}  v2={f2Meta.album}  recommended={null} better={false} />
        <MetaRow label="Year"     v1={f1Meta.year}   v2={f2Meta.year}   recommended={null} better={false} />
      </tbody>
    </table>
  );
}

export default function DuplicateCard({ dup, index, root }) {
  const [loadMeta, setLoadMeta] = useState(false);
  const resolve = useResolveDuplicate();
  const undo    = useUndoDuplicate();

  const hasMeta = dup.f1Meta && dup.f2Meta;
  const { data: fetchedMeta, isFetching } = useDupMeta(index, loadMeta && !hasMeta);

  const f1Meta = dup.f1Meta || fetchedMeta?.f1Meta;
  const f2Meta = dup.f2Meta || fetchedMeta?.f2Meta;
  const recommendation = dup.recommendation ?? fetchedMeta?.recommendation ?? null;

  const shorten = (p) => root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p;

  const keep = (side) => resolve.mutate({ index, keep: side });

  return (
    <div className="surface" style={{ marginBottom: 12, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ background: '#2d1f1f', color: '#f87171', fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase' }}>
          Duplicate
        </span>
        <span style={{ color: 'var(--color-muted)', fontSize: 12 }}>{dup.note}</span>
        {dup.resolution && (
          <span style={{ marginLeft: 'auto', color: 'var(--color-success)', fontSize: 11 }}>
            ✓ Keeping {dup.resolution.keep === 'f1' ? 'File 1' : 'File 2'}
          </span>
        )}
      </div>

      {/* File paths */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid var(--color-border)' }}>
        {[dup.f1, dup.f2].map((f, i) => (
          <div key={i} style={{
            padding: '8px 12px',
            borderRight: i === 0 ? '1px solid var(--color-border)' : 'none',
            background: dup.resolution?.keep === (i === 0 ? 'f1' : 'f2') ? 'color-mix(in srgb, var(--color-success) 6%, transparent)' : 'transparent',
          }}>
            <div style={{ color: 'var(--color-muted)', fontSize: 10, marginBottom: 3 }}>FILE {i + 1}</div>
            <code className="path-text" title={f} style={{ display: 'block', color: 'var(--color-text)' }}>
              {shorten(f)}
            </code>
          </div>
        ))}
      </div>

      {/* Metadata */}
      {f1Meta && f2Meta ? (
        <MetaTable f1Meta={f1Meta} f2Meta={f2Meta} recommendation={recommendation} />
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
          {' '}Recommended: <strong style={{ color: 'var(--color-warning)' }}>File {recommendation === 'f1' ? '1' : '2'}</strong>
          {f1Meta && f2Meta && f1Meta.bitrate !== f2Meta.bitrate ? ' (higher bitrate)' : ' (more complete tags / larger file)'}
        </div>
      )}

      {/* Actions */}
      <div style={{ padding: '10px 16px', borderTop: '1px solid var(--color-border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        {!dup.resolution ? (
          <>
            <button className="btn btn-success"
              style={{ flex: 1 }}
              onClick={() => keep('f1')}
              disabled={resolve.isPending}>
              {recommendation === 'f1' && '★ '}Keep File 1
            </button>
            <button className="btn btn-success"
              style={{ flex: 1 }}
              onClick={() => keep('f2')}
              disabled={resolve.isPending}>
              {recommendation === 'f2' && '★ '}Keep File 2
            </button>
            <button className="btn btn-ghost" onClick={() => {}}>
              Decide Later
            </button>
          </>
        ) : (
          <>
            <span style={{ flex: 1, color: 'var(--color-muted)', fontSize: 12 }}>
              Will delete: <code style={{ fontSize: 11 }}>{shorten(dup.resolution.deleteFile)}</code>
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
