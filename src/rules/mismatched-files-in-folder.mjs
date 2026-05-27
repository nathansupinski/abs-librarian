import path from 'path';
import { ScanRule } from './BaseRule.mjs';

/**
 * Detects a book folder whose audio files don't all belong to that book.
 *
 * Fires in two modes:
 *
 *  • Multi-file (≥2 audio): when ≥40% of files have an ID3 album tag that
 *    doesn't match the folder name. Catches a single folder containing
 *    monolithic MP3s for several different books.
 *
 *  • Single-file (1 audio): when the lone file's album tag is present and
 *    clearly disagrees with the folder. Catches the "wrong file dropped in
 *    a numbered series folder" pattern (e.g. Spellmonger/01 - Spellmonger/
 *    actually holding Journeymage Book 6). Conservative: only fires if the
 *    album tag is set; missing tags are left alone.
 *
 * When ctx.currentSeries is set (the file is inside a detected series
 * container), mismatched files are routed within that series:
 *   Author/Series/AlbumTag/file
 * Otherwise:
 *   Author/AlbumTag/file
 *
 * Files with no album tag in the multi-file case go to _NeedsReview/.
 */
export default class MismatchedFilesInFolderRule extends ScanRule {
  get priority() { return 30; }

  async onBookDir(bookPath, bookName, authorName, authorPath, ctx) {
    const files = ctx.listDir(bookPath);
    const audioFiles = files.filter(f => ctx.isAudio(f) && !f.startsWith('._'));
    if (audioFiles.length === 0) return false;

    const tags = await Promise.all(
      audioFiles.map(f => ctx.readTags(path.join(bookPath, f)))
    );

    const classified = audioFiles.map((f, i) => {
      const album = tags[i].album;
      const artist = tags[i].artist;
      const matches = album ? albumsMatch(bookName, album) : true; // no tag = assume ok
      return { filename: f, album, artist, matches };
    });

    const mismatched = classified.filter(c => !c.matches);

    if (audioFiles.length >= 2) {
      // Multi-file: need at least 2 mismatched AND ≥40% of files
      if (mismatched.length < 2 || mismatched.length < audioFiles.length * 0.4) return false;
    } else {
      // Single-file: only fire when the lone file has an album tag that
      // unambiguously differs from the folder. No album → leave alone.
      if (mismatched.length !== 1 || !classified[0].album) return false;
    }

    // Look up each unique mismatched album via the provider once. The folder
    // is suspect (that's why this rule is firing), so we can't trust its
    // sequence prefix — ask the provider for the canonical sequence instead.
    // No provider match → no sequence prefix; better to leave it off than
    // perpetuate the wrong number from the source folder.
    const albumResolutions = new Map();
    for (const c of classified) {
      if (c.matches || !c.album || albumResolutions.has(c.album)) continue;
      const queryAuthor = c.artist || authorName;
      const r = await ctx.resolveMetadata({
        title: c.album,
        author: queryAuthor,
        preferredSeries: ctx.currentSeries ? [ctx.currentSeries] : [],
      });
      let seq = null;
      let canonicalTitle = null;
      if (r && r.confidence >= 0.55) {
        canonicalTitle = r.title || null;
        if (r.series?.length) {
          // Inside a known series container, prefer the matching series entry
          // so we don't pick up a meta-series sequence (e.g. The Cosmere)
          // when we want the specific one (Spellmonger).
          let matching = null;
          if (ctx.currentSeries) {
            const curLc = ctx.currentSeries.toLowerCase();
            matching = r.series.find(s => s.series?.toLowerCase() === curLc);
          }
          if (!matching) matching = r.series.find(s => s.sequence != null) || r.series[0];
          if (matching?.sequence != null) seq = formatSeq(String(matching.sequence));
        }
      }
      albumResolutions.set(c.album, { providerResult: r, seq, canonicalTitle });
    }

    let handledAny = false;
    for (const { filename, album, artist, matches } of classified) {
      if (matches) continue;
      handledAny = true;

      const filePath = path.join(bookPath, filename);
      const resolution = album ? albumResolutions.get(album) : null;
      const bookTitle = resolution?.canonicalTitle || album || path.basename(filename, path.extname(filename));
      const effectiveAuthor = artist || authorName;
      const seqPrefix = resolution?.seq ? `${resolution.seq} - ` : '';
      const destBookFolder = `${seqPrefix}${bookTitle}`;

      // Inside a detected series container, keep the file under that series
      // (preserves Author/Series/Book structure). Otherwise route by artist.
      const destBase = ctx.currentSeries
        ? path.join(authorPath, ctx.currentSeries)
        : path.join(ctx.root, effectiveAuthor);
      const destLabel = ctx.currentSeries
        ? `${authorName}/${ctx.currentSeries}/${destBookFolder}/`
        : `${effectiveAuthor}/${destBookFolder}/`;

      const providerNote = resolution?.providerResult
        ? `; ${resolution.providerResult.provider} ${Math.round(resolution.providerResult.confidence * 100)}%${resolution.seq ? ` (#${resolution.seq})` : ''}`
        : '';

      if (!album) {
        ctx.addBestGuess(
          filePath,
          null,
          path.join(ctx.root, '_NeedsReview', filename),
          `mismatched file in "${bookName}" — no album tag`,
          `File "${filename}" has no album tag; cannot determine correct destination`
        );
      } else {
        const moveOpts = resolution?.providerResult ? { providerMatch: resolution.providerResult } : {};
        ctx.addMove(
          filePath,
          path.join(destBase, destBookFolder, filename),
          `mismatched file → ${destLabel}`,
          `File is in folder "${bookName}" but album tag says "${album}"${providerNote}`,
          moveOpts,
        );
      }

      ctx.addLookup({
        filename,
        method: resolution?.providerResult ? `provider:${resolution.providerResult.provider}` : (album ? 'id3-tags' : 'filename-parse'),
        result: `${ctx.currentSeries ? `${authorName} / ${ctx.currentSeries}` : effectiveAuthor} / ${destBookFolder}`,
        confidence: resolution?.seq ? 'high' : (album ? 'medium' : 'low'),
        ambiguous: !album,
        notes: `File in wrong folder. Folder: "${bookName}", Album tag: "${album || '(none)'}"${providerNote}`
      });
    }

    if (!handledAny) return false;

    ctx.scanBookForJunk(bookPath, bookName, authorName, false);
    return true;
  }
}

/**
 * Lowercase, strip trailing parenthetical/bracketed annotations, replace
 * punctuation with spaces, collapse whitespace.
 */
function normalizeName(s) {
  return s
    .toLowerCase()
    .replace(/\s*[\[(].*?[\])]$/g, '')   // trailing (series info)
    .replace(/[^a-z0-9\s]/g, ' ')        // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip one or more leading numeric tokens ("05 ", "7 5 ", "13 "). */
function stripLeadingSequence(s) {
  return s.replace(/^(?:\d+\s+)+/, '');
}

/**
 * Two album names match if any of:
 *   - equal after basic normalization,
 *   - one is a word-boundary prefix of the other (shorter + " " starts longer),
 *     tested with and without leading sequence numbers stripped,
 *   - normalized Levenshtein distance is small enough that one is a
 *     near-duplicate of the other (handles "A Feast for Crows" vs
 *     "A Feast Of Crows" — same book, common tag inconsistency).
 *
 * 4-char minimum on the shorter side prevents short common words from
 * triggering the prefix path. Word-boundary prefix (rather than arbitrary
 * substring) avoids the "Harry Potter and the X" vs "Harry Potter and the Y"
 * false positive. Fuzzy threshold 0.15 is tight enough that
 * Chamber/Prisoner-style same-prefix-different-suffix titles still reject.
 */
function albumsMatch(folderName, albumName) {
  const folderRaw = normalizeName(folderName);
  const albumRaw = normalizeName(albumName);
  const folderSeq = stripLeadingSequence(folderRaw);
  const albumSeq = stripLeadingSequence(albumRaw);

  return wordPrefixMatch(folderRaw, albumRaw)
      || wordPrefixMatch(folderSeq, albumSeq)
      || wordPrefixMatch(folderSeq, albumRaw)
      || wordPrefixMatch(folderRaw, albumSeq)
      || fuzzyMatch(folderSeq, albumSeq);
}

function wordPrefixMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.startsWith(shorter + ' ');
}

function fuzzyMatch(a, b) {
  if (!a || !b) return false;
  if (a.length < 8 || b.length < 8) return false;  // avoid matching short titles
  return levenshteinNorm(a, b) <= 0.15;
}

// Normalized Levenshtein (0 = identical, 1 = totally different). Duplicated
// here rather than imported from providers/ to keep the rule self-contained.
function levenshteinNorm(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return 1;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const temp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = temp;
    }
  }
  return dp[m] / Math.max(m, n);
}

/** Zero-pad integer sequences to 2 digits ("6" → "06"); keep decimals as-is. */
function formatSeq(numStr) {
  const n = parseFloat(numStr);
  return !isNaN(n) && Number.isInteger(n) ? String(n).padStart(2, '0') : String(numStr);
}
