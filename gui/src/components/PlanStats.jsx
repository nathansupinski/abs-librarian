import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

export default function PlanStats({ plan }) {
  const qc = useQueryClient();

  if (!plan) return null;

  const items = plan.items || [];
  const approved  = items.filter(i => i.status === 'approved').length;
  const pending   = items.filter(i => i.status === 'pending').length;
  const skipped   = items.filter(i => i.status === 'skipped').length;
  const bestGuess = items.filter(i => i.bestGuess && i.status !== 'skipped').length;
  const dupes     = (plan.duplicates || []).filter(d => !d.resolution).length;

  const stat = (label, value, color) => (
    <div className="flex items-center gap-2">
      <span style={{ color }} className="text-base font-semibold tabular-nums">{value}</span>
      <span style={{ color: 'var(--color-muted)' }} className="text-xs">{label}</span>
    </div>
  );

  return (
    <header style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}
      className="sticky top-0 z-40 px-6 py-3 flex items-center gap-6">
      <span className="font-semibold text-sm tracking-tight" style={{ color: 'var(--color-text)' }}>
        abs-librarian
      </span>
      <div className="flex items-center gap-4 flex-1 overflow-x-auto">
        {stat('approved', approved, 'var(--color-success)')}
        <span style={{ color: 'var(--color-border)' }}>·</span>
        {stat('pending',  pending,  'var(--color-muted)')}
        <span style={{ color: 'var(--color-border)' }}>·</span>
        {stat('skipped',  skipped,  'var(--color-skip)')}
        {bestGuess > 0 && <>
          <span style={{ color: 'var(--color-border)' }}>·</span>
          {stat('best-guess', bestGuess, 'var(--color-warning)')}
        </>}
        {dupes > 0 && <>
          <span style={{ color: 'var(--color-border)' }}>·</span>
          {stat('dupes unresolved', dupes, 'var(--color-danger)')}
        </>}
      </div>
      <button
        className="btn btn-ghost"
        onClick={() => qc.invalidateQueries({ queryKey: ['plan'] })}
        title="Refresh from plan.json"
      >
        <RefreshCw size={13} /> Refresh
      </button>
    </header>
  );
}
