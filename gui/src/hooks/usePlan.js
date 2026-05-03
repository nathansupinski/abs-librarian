import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const PLAN_KEY = ['plan'];

async function fetchPlan() {
  const res = await fetch('/api/plan');
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patchItem({ id, patch }) {
  const res = await fetch(`/api/items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function batchPatch({ ids, patch }) {
  const res = await fetch('/api/items', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, patch }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function fetchDupMeta(index) {
  const res = await fetch(`/api/duplicate-meta/${index}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function fetchGroupDupMeta(index) {
  const res = await fetch(`/api/group-duplicate-meta/${index}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function dismissDuplicate(index) {
  const res = await fetch(`/api/duplicates/${index}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dismiss: true }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function dismissGroupDuplicate(index) {
  const res = await fetch(`/api/group-duplicates/${index}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dismiss: true }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function resolveDuplicate({ index, keep }) {
  const res = await fetch(`/api/duplicates/${index}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keep }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function undoDuplicate(index) {
  const res = await fetch(`/api/duplicates/${index}/resolution`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function resolveGroupDuplicate({ index, keep }) {
  const res = await fetch(`/api/group-duplicates/${index}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keep }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function undoGroupDuplicate(index) {
  const res = await fetch(`/api/group-duplicates/${index}/resolution`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function updateSettings(settings) {
  const res = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function patchItemsBatch(itemPatches) {
  // itemPatches: [{id, patch}, ...]
  const res = await fetch('/api/items', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: itemPatches }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function fetchSeriesSuggest({ title, author }) {
  const params = new URLSearchParams({ title, ...(author ? { author } : {}) });
  const res = await fetch(`/api/series/suggest?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function usePlan() {
  return useQuery({ queryKey: PLAN_KEY, queryFn: fetchPlan });
}

function useMutationWithRefresh(mutFn) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: mutFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: PLAN_KEY }),
  });
}

export function useUpdateItem()              { return useMutationWithRefresh(patchItem); }
export function useBatchUpdate()             { return useMutationWithRefresh(batchPatch); }
export function usePatchItemsBatch()         { return useMutationWithRefresh(patchItemsBatch); }
export function useResolveDuplicate()        { return useMutationWithRefresh(resolveDuplicate); }
export function useUndoDuplicate()           { return useMutationWithRefresh(undoDuplicate); }
export function useDismissDuplicate()        { return useMutationWithRefresh(dismissDuplicate); }
export function useResolveGroupDuplicate()   { return useMutationWithRefresh(resolveGroupDuplicate); }
export function useUndoGroupDuplicate()      { return useMutationWithRefresh(undoGroupDuplicate); }
export function useDismissGroupDuplicate()   { return useMutationWithRefresh(dismissGroupDuplicate); }
export function useUpdateSettings()          { return useMutationWithRefresh(updateSettings); }
export function useSeriesSuggest()           { return useMutation({ mutationFn: fetchSeriesSuggest }); }

// Fetch duplicate metadata on demand (for old plan.json files lacking f1Meta/f2Meta)
export function useDupMeta(index, enabled) {
  return useQuery({
    queryKey: ['dup-meta', index],
    queryFn: () => fetchDupMeta(index),
    enabled,
    staleTime: Infinity, // metadata doesn't change
  });
}

export function useGroupDupMeta(index, enabled) {
  return useQuery({
    queryKey: ['group-dup-meta', index],
    queryFn: () => fetchGroupDupMeta(index),
    enabled,
    staleTime: Infinity,
  });
}
