import path from 'path';
import { ScanRule } from './BaseRule.mjs';
import { cleanBookTitle, parseEmbeddedSeries } from '../core/title-utils.mjs';

/**
 * Detects books belonging to a named series and reorganises them into
 * Author/Series/Title/. Runs before MismatchedFilesInFolderRule so that
 * series-named folders aren't mis-claimed.
 *
 * Strategies (in order, per author directory):
 *
 * 1. Embedded series: folder name explicitly contains "Title - Series, Book N".
 *    Provider call canonicalises the series name once per unique series.
 *
 * 2. Numbered prefix: 2+ sibling folders share a "Series N - Title" prefix.
 *
 * 3. Provider lookup (per book): folder name is cleaned; provider returns
 *    series + sequence. Adds discovered series to the author's known set.
 *
 * 4. Author-level series propagation: for books still unmatched, if the
 *    folder name contains any series name already known for this author
 *    (from steps 1–3), claim it for that series. Catches specials and
 *    audio dramas that providers don't index.
 *
 * Books matched at any stage are claimed in `onBookDir` (returns true) so
 * later rules don't re-classify them.
 */
export default class SeriesDetectionRule extends ScanRule {
  get priority() { return 27; }   // before MismatchedFilesInFolderRule (30)

  // bookPath → { series, sequence, title, source, confidence }
  #detected = new Map();
  #debug = !!process.env.ABS_DEBUG_SERIES;

  #log(...args) { if (this.#debug) console.log('[series]', ...args); }

  async onAuthorDir(authorPath, authorName, ctx) {
    const books = ctx.listDir(authorPath)
      .filter(e => ctx.statOf(path.join(authorPath, e))?.isDirectory());

    // Track which book paths have been resolved at any stage.
    const resolved = new Set();
    // Author-level set of known series names (lowercase → display name).
    const knownSeries = new Map();

    // ── Strategy 1: embedded series in folder name ─────────────────────────
    const embeddedGroups = new Map();   // lc-series → { series, books: [{bookPath, cleanTitle, sequence}] }
    const positionOnly   = [];          // {bookPath, cleanTitle, sequence}

    for (const bookDir of books) {
      const bookPath = path.join(authorPath, bookDir);
      const parsed = parseEmbeddedSeries(bookDir);
      if (!parsed) continue;
      if (parsed.series) {
        const key = parsed.series.toLowerCase();
        if (!embeddedGroups.has(key)) embeddedGroups.set(key, { series: parsed.series, books: [] });
        embeddedGroups.get(key).books.push({
          bookPath, cleanTitle: parsed.cleanTitle, sequence: formatSeq(parsed.sequence),
        });
      } else {
        positionOnly.push({ bookPath, cleanTitle: parsed.cleanTitle, sequence: formatSeq(parsed.sequence) });
      }
    }

    // Canonicalise each embedded series via provider (one call per series).
    for (const [, group] of embeddedGroups) {
      let seriesName = group.series;
      const rep = group.books[0];
      const r = await ctx.resolveMetadata({ title: rep.cleanTitle, author: authorName });
      if (r?.series?.length > 0 && r.confidence >= 0.55) {
        // Prefer the result series that matches the embedded hint (handles
        // cases where Audible returns ["The Cosmere", "The Stormlight Archive"]
        // and the folder name said Stormlight Archive).
        const hint = group.series.toLowerCase();
        const matched = r.series.find(s => s.series &&
          (s.series.toLowerCase().includes(hint) || hint.includes(s.series.toLowerCase())));
        seriesName = matched?.series || pickSeries(r.series, new Map())?.series || r.series[0].series;
      }
      seriesName = cleanSeriesName(seriesName);

      knownSeries.set(seriesName.toLowerCase(), seriesName);
      for (const b of group.books) {
        this.#detected.set(b.bookPath, {
          series: seriesName, sequence: b.sequence, title: b.cleanTitle,
          source: 'embedded', confidence: 'high',
        });
        resolved.add(b.bookPath);
      }
      this.#log(`embedded series "${seriesName}" → ${group.books.length} books`);
    }

    // ── Strategy 2: numbered prefix pattern ("Series N - Title") ──────────
    const GENERIC_PREFIXES = new Set([
      'book', 'vol', 'volume', 'part', 'chapter', 'episode', 'no', 'number',
    ]);
    const prefixGroups = new Map();
    for (const bookDir of books) {
      const bookPath = path.join(authorPath, bookDir);
      if (resolved.has(bookPath)) continue;
      const m = bookDir.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*[-–]\s*(.+)$/);
      if (!m) continue;
      const prefix = m[1].trim(), rawSeq = m[2], title = m[3].trim();
      // Reject generic numbering words ("Book 1 - X" doesn't mean a series called "Book")
      if (GENERIC_PREFIXES.has(prefix.toLowerCase())) continue;
      const key = prefix.toLowerCase();
      if (!prefixGroups.has(key)) prefixGroups.set(key, { prefix, books: [] });
      prefixGroups.get(key).books.push({ bookPath, prefix, rawSeq, title });
    }

    for (const [, group] of prefixGroups) {
      if (group.books.length < 2) continue;
      let seriesName = group.prefix;
      const rep = group.books[0];
      const r = await ctx.resolveMetadata({ title: rep.title, author: authorName });
      if (r?.series?.length > 0 && r.confidence >= 0.55) seriesName = r.series[0].series;
      seriesName = cleanSeriesName(seriesName);

      knownSeries.set(seriesName.toLowerCase(), seriesName);
      for (const b of group.books) {
        this.#detected.set(b.bookPath, {
          series: seriesName, sequence: formatSeq(b.rawSeq), title: b.title,
          source: 'prefix-pattern', confidence: 'medium', groupSize: group.books.length,
        });
        resolved.add(b.bookPath);
      }
      this.#log(`prefix series "${seriesName}" → ${group.books.length} books`);
    }

    // ── Strategy 3: provider lookup per remaining book ─────────────────────
    // Includes positionOnly entries (we know sequence but not series).
    const positionByPath = new Map(positionOnly.map(p => [p.bookPath, p]));

    for (const bookDir of books) {
      const bookPath = path.join(authorPath, bookDir);
      if (resolved.has(bookPath)) continue;
      if (!ctx.hasAudioRecursive(bookPath)) continue;

      const pos = positionByPath.get(bookPath);
      const queryTitle = pos?.cleanTitle ?? cleanBookTitle(bookDir);
      const knownSeq   = pos?.sequence ?? null;

      // Only trust the duration when there's a single audio file at the top
      // level (typical m4b case). For multi-file books, a per-file duration
      // is wildly off vs. the provider's total runtime and corrupts scoring.
      let duration = null;
      const audioFiles = ctx.listDir(bookPath).filter(ctx.isAudio);
      if (audioFiles.length === 1) {
        const tags = await ctx.readTags(path.join(bookPath, audioFiles[0]), true);
        duration = tags.duration ?? null;
      }

      const r = await ctx.resolveMetadata({
        title: queryTitle, author: authorName, duration,
        preferredSeries: [...knownSeries.values()],
      });
      if (!r) { this.#log(`no provider result: ${bookDir}`); continue; }
      if (!r.series?.length) { this.#log(`provider matched "${r.title}" but no series: ${bookDir}`); continue; }
      if (r.confidence < 0.55) { this.#log(`provider conf too low (${r.confidence.toFixed(2)}): ${bookDir}`); continue; }

      // Pick the series that's already known for this author when available
      const chosen = pickSeries(r.series, knownSeries) || r.series[0];
      const seriesName = cleanSeriesName(chosen.series);
      const sequence = knownSeq ?? (chosen.sequence != null ? formatSeq(String(chosen.sequence)) : null);

      knownSeries.set(seriesName.toLowerCase(), seriesName);
      this.#detected.set(bookPath, {
        series: seriesName, sequence, title: r.title || queryTitle,
        source: `provider:${r.provider}`,
        confidence: r.confidence >= 0.85 ? 'high' : 'medium',
        providerMatch: r,
      });
      resolved.add(bookPath);
      this.#log(`provider matched "${r.title}" → ${seriesName} #${sequence ?? '?'} (${r.confidence.toFixed(2)})`);
    }

    // ── Strategy 4: substring against author's known series ───────────────
    // Catches specials/audio-dramas that providers don't index well.
    for (const bookDir of books) {
      const bookPath = path.join(authorPath, bookDir);
      if (resolved.has(bookPath)) continue;
      if (!ctx.hasAudioRecursive(bookPath)) continue;

      const lcName = bookDir.toLowerCase();
      let match = null;
      for (const [lc, name] of knownSeries) {
        if (lc.length >= 4 && lcName.includes(lc)) { match = name; break; }
      }
      if (!match) continue;

      this.#detected.set(bookPath, {
        series: match,
        sequence: null,
        title: cleanBookTitle(bookDir).replace(new RegExp(`\\s*[-_:]?\\s*${escapeRegex(match)}.*$`, 'i'), '').trim() || bookDir,
        source: 'author-series-substring',
        confidence: 'low',
      });
      resolved.add(bookPath);
      this.#log(`substring match "${bookDir}" → ${match}`);
    }

    return false; // let scanner continue to processBookDir for each book
  }

  async onBookDir(bookPath, bookName, authorName, authorPath, ctx) {
    const pre = this.#detected.get(bookPath);
    if (!pre?.series) return false;
    if (!ctx.hasAudioRecursive(bookPath)) return true; // claim but no move

    const { series, sequence, title, source, confidence, providerMatch, groupSize } = pre;
    const seqStr = sequence ? `${sequence} - ` : '';
    const dest   = path.join(authorPath, series, `${seqStr}${title}`);

    const opts = { series: { name: series, sequence } };
    if (providerMatch) opts.providerMatch = providerMatch;

    const seriesLabel = `${series}${sequence ? ` #${sequence}` : ''}`;
    const noteParts = [];
    if (groupSize) noteParts.push(`${groupSize} books matched`);
    if (providerMatch) {
      const pct = Math.round(providerMatch.confidence * 100);
      noteParts.push(`${providerMatch.provider} ${pct}%`);
    }
    if (source === 'author-series-substring') noteParts.push(`folder name contains known series for ${authorName}`);

    ctx.addLookup({
      filename: bookName,
      method: source.startsWith('provider:') ? source : `series:${source}`,
      result: `${authorName} / ${series} / ${seqStr}${title}`,
      confidence,
      notes: noteParts.join('; ') || `series="${series}"`,
    });

    if (confidence === 'high') {
      ctx.addMove(bookPath, dest, `Series detected: ${seriesLabel}`, '', opts);
    } else {
      ctx.addBestGuess(bookPath, dest,
        path.join(authorPath, '_NeedsReview', bookName),
        `Series detected: ${seriesLabel}`,
        noteParts.join('; ') || `Detected via ${source}`,
        opts);
    }

    ctx.scanBookForJunk(bookPath, bookName, authorName, false);
    return true;
  }
}

function formatSeq(numStr) {
  const n = parseFloat(numStr);
  return !isNaN(n) && Number.isInteger(n) ? String(n).padStart(2, '0') : String(numStr);
}

/**
 * Pick the most useful series entry from a provider result.
 *   1. Prefer entries that have a sequence number AND are in the author's
 *      known set (most specific + already confirmed).
 *   2. Then any entry with a sequence (more specific than meta-series).
 *   3. Then any entry that's in the known set.
 *   4. Else null (caller falls back to seriesList[0]).
 *
 * This handles cases like Brandon Sanderson where Audible returns both
 * "The Cosmere" (no sequence) and "The Stormlight Archive" #1 — we want
 * the latter.
 */
function pickSeries(seriesList, knownSeries) {
  const withSeq = seriesList.filter(s => s.series && s.sequence != null);
  for (const s of withSeq) if (knownSeries.has(s.series.toLowerCase())) return s;
  if (withSeq.length) return withSeq[0];
  for (const s of seriesList) if (s.series && knownSeries.has(s.series.toLowerCase())) return s;
  return null;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Strip Audible's editorial annotations like "[publication order]" or "(US)". */
function cleanSeriesName(s) {
  if (!s) return s;
  return s.replace(/\s*[\[(][^\])]+[\])]\s*$/g, '').trim() || s;
}
