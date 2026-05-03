import path from 'path';
import { ScanRule } from './BaseRule.mjs';

/**
 * Detects a book folder that contains BOTH a single combined audiobook file
 * AND a collection of individual chapter files.
 *
 * Trigger condition:
 *   - ≥3 audio files total
 *   - At least one file is ≥8× the median file size (combined file)
 *   - At least 2 files are below that threshold (chapter files)
 *   - The large file's basename resembles the folder name
 *   - Combined size of large file(s) is ≥40% of chapter size — guards against
 *     just-a-longer-than-average chapter being mis-flagged as a combined file.
 *     A true combined file holds the same audio as the chapters, so the totals
 *     should be in the same ballpark even with bitrate differences.
 *
 * The folder is flagged as a group duplicate. The user must resolve it in the
 * GUI (choose combined vs. chapters); the folder is left in place until then.
 */
export default class CombinedChaptersDuplicateRule extends ScanRule {
  get priority() { return 25; }

  async onBookDir(bookPath, bookName, authorName, authorPath, ctx) {
    const files = ctx.listDir(bookPath);
    const audioFiles = files.filter(f => ctx.isAudio(f) && !f.startsWith('._'));
    if (audioFiles.length < 3) return false;

    // Collect sizes
    const withStats = audioFiles.map(f => {
      const p = path.join(bookPath, f);
      return { name: f, path: p, size: ctx.statOf(p)?.size ?? 0 };
    }).filter(f => f.size > 0);

    if (withStats.length < 3) return false;

    const sorted = [...withStats].sort((a, b) => a.size - b.size);
    const median = sorted[Math.floor(sorted.length / 2)].size;
    if (median === 0) return false;

    const threshold = median * 8;
    const large = withStats.filter(f => f.size >= threshold);
    const small = withStats.filter(f => f.size < threshold);

    if (large.length === 0 || small.length < 2) return false;

    // The large file should match the folder name (it's the combined file, not a stray)
    const folderNorm = normalizeName(bookName);
    const largeMatchesFolder = large.some(f => {
      const baseName = normalizeName(path.basename(f.name, path.extname(f.name)));
      // Either contains the first 15 chars of folder name, or folder name contains it
      const prefix = folderNorm.slice(0, Math.min(15, folderNorm.length));
      return baseName.includes(prefix) || folderNorm.includes(baseName.slice(0, 15));
    });
    if (!largeMatchesFolder) return false;

    const totalLargeSize = large.reduce((s, f) => s + f.size, 0);
    const totalSmallSize = small.reduce((s, f) => s + f.size, 0);

    // A real combined file holds the same audio as the chapters, so the byte
    // totals should be comparable. If the "large" file is a tiny fraction of
    // the chapter total, it's just an above-median chapter, not a combined
    // file. 0.4 leaves headroom for bitrate differences (e.g. 64kbps combined
    // vs 128kbps chapters ≈ 0.5 ratio).
    if (totalLargeSize / totalSmallSize < 0.4) return false;

    ctx.addGroupDuplicate(
      {
        files: large.map(f => f.path),
        totalSize: totalLargeSize,
        description: large.length === 1 ? 'Combined file' : `${large.length} combined files`,
      },
      {
        files: small.map(f => f.path),
        totalSize: totalSmallSize,
        description: `${small.length} chapter files`,
      },
      `Combined file + chapter collection in "${bookName}" under ${authorName}`,
      {
        groupALabel: large.length === 1 ? 'Combined file' : 'Combined files',
        groupBLabel: `Chapter files (${small.length})`,
        recommendation: null,
      }
    );

    ctx.addLookup({
      filename: bookName,
      method: 'structure-analysis',
      result: `${authorName} / ${bookName} [group duplicate]`,
      confidence: 'high',
      notes: `${large.length} large file(s) (${fmt(totalLargeSize)}) + ${small.length} chapter files (${fmt(totalSmallSize)}). Resolve in GUI.`,
    });

    // Scan non-audio files for junk (cover.jpg and .m3u stay — not our decision to make)
    ctx.scanBookForJunk(bookPath, bookName, authorName, false);
    return true;
  }
}

function normalizeName(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fmt(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}
