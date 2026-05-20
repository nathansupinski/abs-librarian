import path from 'path';
import { ScanRule } from './BaseRule.mjs';

/**
 * Extracts books from a "mixed leaf" — a single directory directly containing
 * audio files that belong to 2+ different albums (books). This is the pattern
 * left behind when multiple complete audiobooks are dumped into one folder, or
 * when previous scan runs created incorrect nesting (e.g. Harry Potter/03 -
 * .../02 - .../[7 different books].mp3).
 *
 * Trigger (all must hold):
 *  - The book directory has no audio at its own root level.
 *  - Somewhere underneath it, a directory directly contains audio files whose
 *    ID3 album tags span 2+ distinct titles.
 *
 * Only files inside such mixed leaves are extracted; siblings that are pure
 * (single-album folders, e.g. NN - Title/chapter01.mp3) are left untouched.
 * This is deliberately narrow: the rule must not fire for series containers
 * whose books are already split into per-book subfolders, even when sequence
 * numbers are wrong or folder names include narrator suffixes — fixing those
 * is outside this rule's scope.
 *
 * For each album group in a mixed leaf, the destination is
 *   Author/Container/[Seq - ]AlbumTitle/filename
 * The folder name comes from the ID3 album tag (ground truth). The sequence
 * prefix comes from a metadata provider lookup when confidence ≥ 0.55.
 *
 * Files with no album tag inside mixed leaves go to _NeedsReview/.
 *
 * Defense-in-depth: a per-file source===destination check skips no-op items.
 *
 * Priority 29 — runs after SeriesDetectionRule (27) so series-detected books
 * are not double-processed, before MismatchedFilesInFolderRule (30).
 */
export default class NestedSeriesContainerRule extends ScanRule {
  get priority() { return 29; }

  async onBookDir(bookPath, bookName, authorName, authorPath, ctx) {
    // Only process dirs with no direct audio but audio nested inside.
    const rootAudio = ctx.listDir(bookPath).filter(f => ctx.isAudio(f) && !f.startsWith('._'));
    if (rootAudio.length > 0) return false;
    if (!ctx.hasAudioRecursive(bookPath)) return false;

    // Walk every audio-bearing directory under bookPath and collect its files+tags.
    const leaves = [];
    await collectAudioLeaves(bookPath, ctx, leaves);
    if (leaves.length === 0) return false;

    // Identify the mixed leaves — directories whose own audio files span 2+ albums.
    const mixedLeaves = leaves.filter(leaf => {
      const albums = new Set();
      for (const { tags } of leaf.files) {
        const a = tags.album?.trim();
        if (a) albums.add(a.toLowerCase());
      }
      return albums.size >= 2;
    });
    if (mixedLeaves.length === 0) return false;

    // Group all files in mixed leaves by album tag.
    const albumGroups = new Map();
    const noTagFiles = [];
    for (const leaf of mixedLeaves) {
      for (const { file, tags } of leaf.files) {
        const album = tags.album?.trim();
        if (!album) { noTagFiles.push({ file, tags }); continue; }
        const key = album.toLowerCase();
        if (!albumGroups.has(key)) albumGroups.set(key, { album, entries: [] });
        albumGroups.get(key).entries.push({ file, tags });
      }
    }

    let handledAny = false;

    for (const [, group] of albumGroups) {
      const artist = group.entries[0].tags.artist || authorName;
      // Pass duration only when there is exactly one file — per-chapter
      // durations corrupt provider scoring against full-book runtimes.
      const duration = group.entries.length === 1 ? (group.entries[0].tags.duration ?? null) : null;

      const r = await ctx.resolveMetadata({
        title: group.album,
        author: artist,
        duration,
        preferredSeries: [bookName],
      });

      // Decide which series folder this album belongs in. By default keep it
      // under the container, but if the provider confidently says it belongs
      // elsewhere, route it there — the container is often a catch-all that
      // accidentally swept in books from other series or stand-alones.
      const containerLc = bookName.toLowerCase();
      let destSeries = bookName;       // null = place at author root (stand-alone)
      let seqStr = '';
      if (r && r.confidence >= 0.55) {
        const matchingSeries = (r.series || []).find(s => s.series &&
          (s.series.toLowerCase() === containerLc ||
           s.series.toLowerCase().includes(containerLc) ||
           containerLc.includes(s.series.toLowerCase())));
        if (matchingSeries) {
          // Provider confirms the container series — keep here and pick its sequence
          if (matchingSeries.sequence != null) seqStr = formatSeq(String(matchingSeries.sequence)) + ' - ';
        } else if (r.series?.length) {
          // Provider says this belongs to a different series — route there
          const chosen = r.series.find(s => s.sequence != null) || r.series[0];
          if (chosen?.series) destSeries = chosen.series;
          if (chosen?.sequence != null) seqStr = formatSeq(String(chosen.sequence)) + ' - ';
        } else {
          // High-confidence match with no series → stand-alone at author root
          destSeries = null;
        }
      }

      const destFolder = destSeries
        ? path.join(authorPath, destSeries, seqStr + group.album)
        : path.join(authorPath, seqStr + group.album);
      const destLabel = destSeries
        ? `${destSeries}/${seqStr}${group.album}/`
        : `${seqStr}${group.album}/`;
      const noteParts = [`album="${group.album}"`];
      if (r) noteParts.push(`${r.provider} ${Math.round(r.confidence * 100)}%`);
      if (destSeries !== bookName) noteParts.push(`routed out of container "${bookName}"`);

      for (const { file } of group.entries) {
        const filename = path.basename(file);
        const dest = path.join(destFolder, filename);
        if (file === dest) continue; // already in place — no-op
        ctx.addMove(
          file,
          dest,
          `nested series extraction → ${destLabel}`,
          noteParts.join('; '),
          r ? { providerMatch: r } : {},
        );
        ctx.addLookup({
          filename,
          method: r ? `provider:${r.provider}` : 'id3-tags',
          result: `${artist} / ${destLabel}`,
          confidence: r?.confidence >= 0.55 ? (r.confidence >= 0.85 ? 'high' : 'medium') : 'high',
          notes: `Extracted from mixed leaf; ${noteParts.join('; ')}`,
        });
        handledAny = true;
      }
    }

    for (const { file } of noTagFiles) {
      const filename = path.basename(file);
      const fallback = path.join(authorPath, '_NeedsReview', filename);
      if (file === fallback) continue;
      ctx.addBestGuess(
        file,
        null,
        fallback,
        `nested file in "${bookName}" — no album tag`,
        `File "${filename}" has no album tag; cannot determine correct destination`,
      );
      ctx.addLookup({
        filename,
        method: 'filename-parse',
        result: '_NeedsReview',
        confidence: 'low',
        ambiguous: true,
        notes: `Extracted from mixed leaf; no album tag`,
      });
      handledAny = true;
    }

    if (!handledAny) return false;
    ctx.scanBookForJunk(bookPath, bookName, authorName, true);
    return true;
  }
}

async function collectAudioLeaves(dir, ctx, results) {
  const audioFiles = [];
  const subdirs = [];
  for (const entry of ctx.listDir(dir)) {
    if (entry.startsWith('._')) continue;
    const p = path.join(dir, entry);
    const stat = ctx.statOf(p);
    if (!stat) continue;
    if (stat.isFile() && ctx.isAudio(entry)) audioFiles.push(p);
    else if (stat.isDirectory() && !entry.startsWith('.')) subdirs.push(p);
  }
  if (audioFiles.length > 0) {
    const tagsList = await Promise.all(audioFiles.map(f => ctx.readTags(f, true)));
    results.push({ dir, files: audioFiles.map((f, i) => ({ file: f, tags: tagsList[i] })) });
  }
  for (const sub of subdirs) await collectAudioLeaves(sub, ctx, results);
}

function formatSeq(numStr) {
  const n = parseFloat(numStr);
  return !isNaN(n) && Number.isInteger(n) ? String(n).padStart(2, '0') : String(numStr);
}
