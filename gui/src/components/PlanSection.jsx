import React, { useState, useRef } from 'react';
import { ChevronDown, ChevronRight, CheckCheck, MinusCircle } from 'lucide-react';
import { useBatchUpdate } from '../hooks/usePlan.js';
import ItemRow from './ItemRow.jsx';

// Extract the last 3 path segments relative to root, used as a group key
function groupKey(source, root) {
  let rel = source;
  if (root && source.startsWith(root + '/')) rel = source.slice(root.length + 1);
  const parts = rel.split('/');
  // Remove the filename for MOVE_FILE — group by parent dir
  const dir = parts.slice(0, -1);
  // Use at most the first 2 segments (author / book) as the group
  return dir.slice(0, 2).join('/') || dir[0] || 'root';
}

function groupItems(items, root) {
  const groups = new Map();
  for (const item of items) {
    const key = groupKey(item.source, root);
    if (!groups.has(key)) groups.set(key, { label: key, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

function GroupHeader({ label, items, onBatch, batchPending }) {
  const pendingIds = items.filter(i => i.status === 'pending').length;
  const approvedIds = items.filter(i => i.status === 'approved').length;
  const allIds = items.map(i => i.id);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '6px 16px',
      background: 'var(--color-surface-2)', borderBottom: '1px solid var(--color-border)',
      position: 'sticky', top: 48, zIndex: 10,
    }}>
      <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--color-accent-hover)', flex: 1 }}>
        {label}
      </span>
      <span style={{ color: 'var(--color-muted)', fontSize: 11 }}>
        {items.length} items
        {pendingIds > 0 && ` · ${pendingIds} pending`}
        {approvedIds > 0 && ` · ${approvedIds} approved`}
      </span>
      <button className="btn btn-success" style={{ fontSize: 11 }}
        disabled={batchPending}
        onClick={() => onBatch(allIds, 'approved')}>
        <CheckCheck size={11} /> Approve All
      </button>
      <button className="btn btn-danger" style={{ fontSize: 11 }}
        disabled={batchPending}
        onClick={() => onBatch(allIds, 'skipped')}>
        <MinusCircle size={11} /> Skip All
      </button>
    </div>
  );
}

export default function PlanSection({ title, items, root, selection, onSelect, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const batchUpdate = useBatchUpdate();
  const lastClickedRef = useRef(null);

  if (!items || items.length === 0) return null;

  const groups = groupItems(items, root);
  const allIds = items.map(i => i.id);
  const allVisibleIds = items.map(i => i.id); // for shift-click range

  const handleBatch = (ids, status) => {
    batchUpdate.mutate({ ids, patch: { status } });
  };

  const sectionPending  = items.filter(i => i.status === 'pending').length;
  const sectionApproved = items.filter(i => i.status === 'approved').length;
  const sectionSkipped  = items.filter(i => i.status === 'skipped').length;

  return (
    <section className="surface" style={{ marginBottom: 16, overflow: 'hidden' }}>
      {/* Section header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', background: 'transparent', border: 'none',
          borderBottom: open ? '1px solid var(--color-border)' : 'none',
          cursor: 'pointer', color: 'var(--color-text)',
        }}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1, textAlign: 'left' }}>
          {title}
          <span style={{ color: 'var(--color-muted)', fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
            ({items.length})
          </span>
        </span>
        <span style={{ color: 'var(--color-muted)', fontSize: 11, display: 'flex', gap: 12 }}>
          {sectionApproved > 0 && <span style={{ color: 'var(--color-success)' }}>{sectionApproved} approved</span>}
          {sectionPending > 0  && <span>{sectionPending} pending</span>}
          {sectionSkipped > 0  && <span style={{ color: 'var(--color-skip)' }}>{sectionSkipped} skipped</span>}
        </span>
        {open && (
          <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
            <button className="btn btn-success" style={{ fontSize: 11 }}
              onClick={() => handleBatch(allIds, 'approved')}
              disabled={batchUpdate.isPending}>
              <CheckCheck size={11} /> Approve All
            </button>
            <button className="btn btn-danger" style={{ fontSize: 11 }}
              onClick={() => handleBatch(allIds, 'skipped')}
              disabled={batchUpdate.isPending}>
              <MinusCircle size={11} /> Skip All
            </button>
          </div>
        )}
      </button>

      {open && (
        <div>
          {groups.map(group => (
            <div key={group.label}>
              {groups.length > 1 && (
                <GroupHeader
                  label={group.label}
                  items={group.items}
                  onBatch={handleBatch}
                  batchPending={batchUpdate.isPending}
                />
              )}
              {group.items.map(item => (
                <ItemRow
                  key={item.id}
                  item={item}
                  root={root}
                  selected={selection.has(item.id)}
                  onSelect={(id, shiftKey, visibleIds) => {
                    onSelect(id, shiftKey, visibleIds, lastClickedRef);
                  }}
                  allVisibleIds={allVisibleIds}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
