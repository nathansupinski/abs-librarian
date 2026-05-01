import React, { useState, useRef, useCallback } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { usePlan } from './hooks/usePlan.js';
import PlanStats from './components/PlanStats.jsx';
import PlanSection from './components/PlanSection.jsx';
import DuplicateCard from './components/DuplicateCard.jsx';
import GroupDuplicateCard from './components/GroupDuplicateCard.jsx';
import BatchToolbar from './components/BatchToolbar.jsx';
import RunControls from './components/RunControls.jsx';

// Extract ROOT from the plan (derived from ignoreFile path or first item)
function inferRoot(plan) {
  if (plan.ignoreFile) {
    const parts = plan.ignoreFile.replace(/\\/g, '/').split('/');
    parts.pop(); // remove filename
    return parts.join('/');
  }
  const first = plan.items?.[0];
  if (first?.source) {
    const parts = first.source.replace(/\\/g, '/').split('/');
    return '/' + parts.slice(1, 3).join('/'); // e.g. /mnt/user
  }
  return '';
}

export default function App() {
  const { data: plan, isLoading, error } = usePlan();
  const [selection, setSelection] = useState(new Set());
  const lastClickedRef = useRef(null);

  const handleSelect = useCallback((id, shiftKey, visibleIds) => {
    setSelection(prev => {
      const next = new Set(prev);
      if (shiftKey && lastClickedRef.current && visibleIds) {
        const a = visibleIds.indexOf(lastClickedRef.current);
        const b = visibleIds.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
          visibleIds.slice(lo, hi + 1).forEach(vid => next.add(vid));
          lastClickedRef.current = id;
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      lastClickedRef.current = id;
      return next;
    });
  }, []);

  const clearSelection = () => setSelection(new Set());

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 10 }}>
        <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ color: 'var(--color-muted)' }}>Loading plan...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 10 }}>
        <AlertCircle size={20} style={{ color: 'var(--color-danger)' }} />
        <span style={{ color: 'var(--color-danger)' }}>Failed to load plan: {error.message}</span>
      </div>
    );
  }

  if (!plan) return null;

  const root              = inferRoot(plan);
  const duplicatesFolder  = plan.settings?.duplicatesFolder || null;
  const items             = plan.items || [];
  const duplicates        = plan.duplicates || [];
  const groupDuplicates   = plan.groupDuplicates || [];

  const bestGuess     = items.filter(i => i.bestGuess);
  const confirmed     = items.filter(i => !i.bestGuess && !i.junk);
  const junk          = items.filter(i => i.junk);

  return (
    <div style={{ minHeight: '100vh' }}>
      <PlanStats plan={plan} />
      <RunControls />

      <main style={{ maxWidth: 1600, margin: '0 auto', padding: '20px 24px 80px' }}>

        {bestGuess.length > 0 && (
          <PlanSection
            title="Best Guesses"
            items={bestGuess}
            root={root}
            selection={selection}
            onSelect={handleSelect}
            defaultOpen={true}
          />
        )}

        {confirmed.length > 0 && (
          <PlanSection
            title="Confirmed Moves"
            items={confirmed}
            root={root}
            selection={selection}
            onSelect={handleSelect}
            defaultOpen={bestGuess.length === 0}
          />
        )}

        {junk.length > 0 && (
          <PlanSection
            title="Junk Items"
            items={junk}
            root={root}
            selection={selection}
            onSelect={handleSelect}
            defaultOpen={false}
          />
        )}

        {groupDuplicates.length > 0 && (
          <section className="surface" style={{ marginBottom: 16, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', fontWeight: 600, fontSize: 14 }}>
              Group Duplicates
              <span style={{ color: 'var(--color-muted)', fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
                (combined file vs. chapter files — {groupDuplicates.length})
              </span>
            </div>
            <div style={{ padding: 16 }}>
              {groupDuplicates.map((gd, i) => (
                <GroupDuplicateCard key={i} gdup={gd} index={i} root={root} duplicatesFolder={duplicatesFolder} />
              ))}
            </div>
          </section>
        )}

        {duplicates.length > 0 && (
          <section className="surface" style={{ marginBottom: 16, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', fontWeight: 600, fontSize: 14 }}>
              Duplicates
              <span style={{ color: 'var(--color-muted)', fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
                ({duplicates.length})
              </span>
            </div>
            <div style={{ padding: 16 }}>
              {duplicates.map((dup, i) => (
                <DuplicateCard key={i} dup={dup} index={i} root={root} duplicatesFolder={duplicatesFolder} />
              ))}
            </div>
          </section>
        )}

        {items.length === 0 && duplicates.length === 0 && groupDuplicates.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--color-muted)' }}>
            <div style={{ fontSize: 16 }}>No items in plan</div>
            <div style={{ fontSize: 13, marginTop: 8 }}>Run the dry-run scan first: <code>node reorganize.mjs --root /path</code></div>
          </div>
        )}
      </main>

      <BatchToolbar selection={selection} onClear={clearSelection} />

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
