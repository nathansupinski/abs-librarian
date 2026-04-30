import React from 'react';
import { CheckCheck, X, MinusCircle } from 'lucide-react';
import { useBatchUpdate } from '../hooks/usePlan.js';

export default function BatchToolbar({ selection, onClear }) {
  const batchUpdate = useBatchUpdate();
  const count = selection.size;
  if (count === 0) return null;

  const ids = [...selection];

  const approve = () => batchUpdate.mutate({ ids, patch: { status: 'approved' } }, { onSuccess: onClear });
  const skip    = () => batchUpdate.mutate({ ids, patch: { status: 'skipped'  } }, { onSuccess: onClear });

  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      background: 'var(--color-surface-2)', border: '1px solid var(--color-border)',
      borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center',
      gap: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', zIndex: 100,
    }}>
      <span style={{ color: 'var(--color-text)', fontWeight: 600, fontSize: 13 }}>
        {count} selected
      </span>
      <button className="btn btn-success" onClick={approve} disabled={batchUpdate.isPending}>
        <CheckCheck size={13} /> Approve
      </button>
      <button className="btn btn-danger" onClick={skip} disabled={batchUpdate.isPending}>
        <MinusCircle size={13} /> Skip
      </button>
      <button className="btn btn-ghost" onClick={onClear}>
        <X size={13} /> Clear
      </button>
    </div>
  );
}
