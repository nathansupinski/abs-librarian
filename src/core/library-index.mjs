import path from 'path';
import { HARD_SKIP, NON_AUDIOBOOK_DIRS } from './constants.mjs';
import { listDir, statOf, isAudio } from './fs-utils.mjs';
import { readTags } from './metadata.mjs';

const SKIP_DIRS = new Set([
  ...HARD_SKIP,
  ...NON_AUDIOBOOK_DIRS,
  '_NeedsReview',
  '_misc',
  '_non-audiobook',
]);

// Walk destRoot once, collect every "audio-bearing leaf directory" — a
// directory containing one or more audio files at its own root level. Each
// leaf is sampled for its first audio file's ID3 tags, keyed by artist|album
// (lowercased). Multiple leaves can share a key (e.g. abridged vs unabridged
// pressings).
//
// Returns { byPath: Set<string>, byContent: Map<"artist|album", string[]> }.
// byPath holds every audio file path discovered.
export async function buildLibraryIndex(destRoot, { concurrency = 8 } = {}) {
  const byPath = new Set();
  const byContent = new Map();
  if (!statOf(destRoot)) return { byPath, byContent };

  const leaves = [];   // [{ dir, sampleFile }]
  walk(destRoot);

  function walk(dir) {
    const entries = listDir(dir);
    const audioHere = [];
    const subdirs = [];
    for (const e of entries) {
      if (e.startsWith('.') || e.startsWith('._')) continue;
      if (SKIP_DIRS.has(e)) continue;
      const p = path.join(dir, e);
      const s = statOf(p);
      if (!s) continue;
      if (s.isFile() && isAudio(e)) {
        audioHere.push(p);
        byPath.add(p);
      } else if (s.isDirectory()) {
        subdirs.push(p);
      }
    }
    if (audioHere.length > 0) {
      audioHere.sort();
      leaves.push({ dir, sampleFile: audioHere[0] });
    }
    for (const sub of subdirs) walk(sub);
  }

  // Bounded-concurrency read of every leaf's sample file.
  const results = await mapPool(leaves, concurrency, async (leaf) => {
    const tags = await readTags(leaf.sampleFile, false).catch(() => null);
    if (!tags) return null;
    return { leaf, tags };
  });

  for (const r of results) {
    if (!r?.tags) continue;
    const artist = (r.tags.artist || '').trim().toLowerCase();
    const album  = (r.tags.album  || '').trim().toLowerCase();
    if (!artist && !album) continue;
    const key = `${artist}|${album}`;
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push(r.leaf.dir);
  }

  return { byPath, byContent };
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const my = i++;
      results[my] = await fn(items[my]);
    }
  });
  await Promise.all(workers);
  return results;
}
