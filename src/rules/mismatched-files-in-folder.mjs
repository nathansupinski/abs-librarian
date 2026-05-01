import path from 'path';
import { ScanRule } from './BaseRule.mjs';

/**
 * Detects a book folder whose audio files don't all belong to that book.
 *
 * Trigger condition: ≥50% of audio files have an ID3 album tag that does NOT
 * match the folder name (after normalization). This catches the pattern where
 * a single folder (e.g., "Harry Potter and the Chamber of Secrets") contains
 * monolithic MP3s for several different books in the series.
 *
 * Each mismatched file is moved to Author/AlbumTag/ (or best-guessed to
 * _NeedsReview/ if the album tag is missing). Files that DO match the folder
 * name stay in place (they're already correct).
 */
export default class MismatchedFilesInFolderRule extends ScanRule {
  get priority() { return 30; }

  async onBookDir(bookPath, bookName, authorName, authorPath, ctx) {
    const files = ctx.listDir(bookPath);
    const audioFiles = files.filter(f => ctx.isAudio(f) && !f.startsWith('._'));
    if (audioFiles.length < 2) return false;

    // Read tags for all audio files in parallel
    const tags = await Promise.all(
      audioFiles.map(f => ctx.readTags(path.join(bookPath, f)))
    );

    const folderNorm = normalizeName(bookName);

    // Determine which files belong here vs. elsewhere
    const classified = audioFiles.map((f, i) => {
      const album = tags[i].album;
      const artist = tags[i].artist;
      const albumNorm = album ? normalizeName(album) : null;
      const matches = albumNorm ? albumsMatch(folderNorm, albumNorm) : true; // no tag = assume ok
      return { filename: f, album, artist, matches };
    });

    const mismatched = classified.filter(c => !c.matches);
    // Only fire if a substantial portion of files are mismatched
    if (mismatched.length < 2 || mismatched.length < audioFiles.length * 0.4) return false;

    // Emit plan items for every audio file — matched ones stay (no plan item),
    // mismatched ones get moved to their proper location
    let handledAny = false;
    for (const { filename, album, artist, matches } of classified) {
      if (matches) continue; // already in the right place
      handledAny = true;

      const filePath = path.join(bookPath, filename);
      const bookTitle = album || path.basename(filename, path.extname(filename));
      const effectiveAuthor = artist || authorName;

      if (!album) {
        // No tag — best guess to _NeedsReview
        ctx.addBestGuess(
          filePath,
          null,
          path.join(ctx.root, '_NeedsReview', filename),
          `mismatched file in "${bookName}" — no album tag`,
          `File "${filename}" has no album tag; cannot determine correct destination`
        );
      } else {
        ctx.addMove(
          filePath,
          path.join(ctx.root, effectiveAuthor, bookTitle, filename),
          `mismatched file → ${effectiveAuthor}/${bookTitle}/`,
          `File is in folder "${bookName}" but album tag says "${album}"`
        );
      }

      ctx.addLookup({
        filename,
        method: album ? 'id3-tags' : 'filename-parse',
        result: `${effectiveAuthor} / ${bookTitle}`,
        confidence: album ? 'high' : 'low',
        ambiguous: !album,
        notes: `File in wrong folder. Folder: "${bookName}", Album tag: "${album || '(none)'}"`
      });
    }

    if (!handledAny) return false;

    // Scan non-audio files for junk (non-recursive — no subdirs expected here)
    ctx.scanBookForJunk(bookPath, bookName, authorName, false);
    return true;
  }
}

/**
 * Normalize a string for comparison: lowercase, remove punctuation,
 * collapse whitespace, and strip common suffixes like series info in
 * parentheses or brackets.
 */
function normalizeName(s) {
  return s
    .toLowerCase()
    .replace(/\s*[\[(].*?[\])]$/g, '')   // strip trailing (series info) or [brackets]
    .replace(/[^a-z0-9\s]/g, ' ')         // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Two album names match if they are identical after normalization, or if one
 * strictly contains the other (e.g. "The Wise Man's Fear" is a prefix of
 * "The Wise Man's Fear - Kingkiller Chronicles, Day 2").
 *
 * No leading-words heuristic — that causes false positives for series like
 * "Harry Potter and the X" vs "Harry Potter and the Y" which share a common
 * prefix but are different books.
 */
function albumsMatch(folderNorm, albumNorm) {
  if (folderNorm === albumNorm) return true;
  // Strict containment: shorter name is a complete substring of the longer
  if (albumNorm.length >= 10 && folderNorm.includes(albumNorm)) return true;
  if (folderNorm.length >= 10 && albumNorm.includes(folderNorm)) return true;
  return false;
}
