import React, { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useResolveGroupDuplicate, useUndoGroupDuplicate } from '../hooks/usePlan.js';

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

function GroupColumn({ label, group, isKept, shorten, last }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      flex: 1,
      padding: '10px 12px',
      background: isKept ? 'color-mix(in srgb, var(--color-success) 6%, transparent)' : 'transparent',
      borderRight: last ? 'none' : '1px solid var(--color-border)',
    }}>
      <div style={{ color: 'var(--color-muted)', fontSize: 10, marginBottom: 4 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{group.description}</span>
        <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>{formatSize(group.totalSize)}</span>
      </div>

      {group.files.length === 1 ? (
        <code className="path-text" title={group.files[0]} style={{ display: 'block', color: 'var(--color-text)', fontSize: 11 }}>
          {shorten(group.files[0])}
        </code>
      ) : (
        <>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 11, padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setExpanded(v => !v)}
          >
            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {expanded ? 'Hide files' : `Show ${group.files.length} files`}
          </button>
          {expanded && (
            <div style={{ marginTop: 6, maxHeight: 200, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace' }}>
              {group.files.map((f, i) => (
                <div key={i} style={{ padding: '2px 0', color: 'var(--color-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f}>
                  {shorten(f)}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function GroupDuplicateCard({ gdup, index, root, duplicatesFolder }) {
  const resolve = useResolveGroupDuplicate();
  const undo    = useUndoGroupDuplicate();

  const shorten = p => root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
  const keep = (which) => resolve.mutate({ index, keep: which });

  const keptLabel = gdup.resolution?.keep === 'groupA' ? gdup.groupALabel : gdup.groupBLabel;

  return (
    <div className="surface" style={{ marginBottom: 12, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ background: '#1f2d2d', color: '#34d399', fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase' }}>
          Group Duplicate
        </span>
        <span style={{ color: 'var(--color-muted)', fontSize: 12 }}>{gdup.note}</span>
        {gdup.resolution && (
          <span style={{ marginLeft: 'auto', color: 'var(--color-success)', fontSize: 11 }}>
            ✓ Keeping {keptLabel}
          </span>
        )}
      </div>

      {/* Two-column comparison */}
      <div style={{ display: 'flex' }}>
        <GroupColumn
          label={gdup.groupALabel}
          group={gdup.groupA}
          isKept={gdup.resolution?.keep === 'groupA'}
          shorten={shorten}
        />
        <GroupColumn
          label={gdup.groupBLabel}
          group={gdup.groupB}
          isKept={gdup.resolution?.keep === 'groupB'}
          shorten={shorten}
          last
        />
      </div>

      {/* Actions */}
      <div style={{ padding: '10px 16px', borderTop: '1px solid var(--color-border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        {!gdup.resolution ? (
          <>
            <button className="btn btn-success" style={{ flex: 1 }}
              onClick={() => keep('groupA')} disabled={resolve.isPending}
              title={duplicatesFolder ? `Keep ${gdup.groupALabel} — ${gdup.groupBLabel} will be moved to ${duplicatesFolder}` : `Keep ${gdup.groupALabel} — ${gdup.groupBLabel} will be deleted (requires --delete-junk)`}>
              Keep {gdup.groupALabel}
            </button>
            <button className="btn btn-success" style={{ flex: 1 }}
              onClick={() => keep('groupB')} disabled={resolve.isPending}
              title={duplicatesFolder ? `Keep ${gdup.groupBLabel} — ${gdup.groupALabel} will be moved to ${duplicatesFolder}` : `Keep ${gdup.groupBLabel} — ${gdup.groupALabel} will be deleted (requires --delete-junk)`}>
              Keep {gdup.groupBLabel}
            </button>
            <button className="btn btn-ghost" onClick={() => {}}>
              Decide Later
            </button>
          </>
        ) : (
          <>
            <span style={{ flex: 1, color: 'var(--color-muted)', fontSize: 12 }}>
              {duplicatesFolder ? 'Will move to ' : 'Will delete '}
              {gdup.resolution.keep === 'groupA' ? gdup.groupBLabel : gdup.groupALabel}
              {' '}({gdup.resolution.keep === 'groupA' ? gdup.groupB.files.length : gdup.groupA.files.length} file(s))
              {duplicatesFolder && <> → <code style={{ fontSize: 11 }}>{duplicatesFolder}</code></>}
            </span>
            <button className="btn btn-ghost"
              onClick={() => undo.mutate(index)} disabled={undo.isPending}>
              Undo
            </button>
          </>
        )}
      </div>
    </div>
  );
}
