import { OpenLibraryProvider } from './OpenLibraryProvider.mjs';
import { GoogleBooksProvider } from './GoogleBooksProvider.mjs';
import { AudibleProvider } from './AudibleProvider.mjs';
import { AudnexusProvider } from './AudnexusProvider.mjs';

// Levenshtein distance between two strings (normalized to 0–1 range).
function levenshteinNorm(a, b) {
  if (!a || !b) return 1;
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 0;
  const m = a.length, n = b.length;
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

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Loose language match. Keeps results with no language metadata (providers vary
 * in what they return). Compares lowercased; prefix match in either direction
 * handles 'english' vs 'en' and similar full-name/ISO-code mismatches.
 */
function languageMatches(resultLang, preferredLang) {
  if (!resultLang || !preferredLang) return true;
  const a = String(resultLang).toLowerCase();
  const b = String(preferredLang).toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Tiebreak among scored candidates: if any candidate within `tolerance` of the
 * top score has a series in `preferredLc`, return it; otherwise return the top.
 * Lets caller-supplied context (e.g. other books by the same author already
 * matched to a known series) override coincidental higher scores from
 * foreign-language editions or meta-series.
 */
function preferSeries(scored, preferredLc, tolerance) {
  if (!preferredLc.size || scored.length < 2) return scored[0];
  const cutoff = scored[0]._confidence - tolerance;
  for (const c of scored) {
    if (c._confidence < cutoff) break;
    if ((c.series || []).some(s => s?.series && preferredLc.has(s.series.toLowerCase()))) {
      return c;
    }
  }
  return scored[0];
}

function scoreResult(query, result) {
  const qNorm = normalizeTitle(query.title);
  const rNorm = normalizeTitle(result.title);
  let titleSim = 1 - levenshteinNorm(qNorm, rNorm);
  // Substring containment is treated as a strong title match (handles subtitles
  // and prefixes added to folder names by importers).
  if (qNorm && rNorm && (qNorm.includes(rNorm) || rNorm.includes(qNorm))) {
    titleSim = Math.max(titleSim, 0.9);
  }
  const authorSim = (query.author && result.author)
    ? 1 - levenshteinNorm(normalizeTitle(query.author), normalizeTitle(result.author))
    : 0.5; // neutral when either side is unknown

  if (query.duration && result.duration) {
    const ratio = Math.min(query.duration, result.duration) / Math.max(query.duration, result.duration);
    // Wildly mismatched durations usually mean the caller passed a per-chapter
    // duration instead of the full book runtime. Fall back to text-only
    // scoring so the duration term doesn't sabotage an otherwise-correct match.
    if (ratio < 0.4) return Math.min(1, (titleSim * 0.2 + authorSim * 0.1) / 0.3);
    return Math.min(1, titleSim * 0.2 + authorSim * 0.1 + ratio * 0.7);
  }
  // No duration — normalize title+author weights to fill 0–1 range
  return Math.min(1, (titleSim * 0.2 + authorSim * 0.1) / 0.3);
}

export class MetadataResolver {
  #cache = new Map();      // key → { result, ts }
  #maxCacheSize = 500;
  #cacheTtl = 60 * 60 * 1000; // 1 hour
  #fuzzyThreshold = 0.4;
  #confidenceThreshold = 0.6;
  // How far below the top score a candidate may sit and still win on a
  // preferred-series tiebreak. Just under the duration term's full weight (0.7),
  // so a foreign-language edition that scores high on duration coincidence
  // can't outrank an English match in a series we've already identified.
  #preferTolerance = 0.15;
  // Library language. Provider results in another language are dropped before
  // scoring so foreign editions can't win on coincidental title/duration match.
  // Match is prefix-based so 'english' (Audible) and 'en' (GoogleBooks) both
  // satisfy a preference of 'english'. Results with no language metadata
  // (e.g. OpenLibrary always nulls it) are kept.
  #language = 'english';

  constructor(options = {}) {
    this.providers = options.providers ?? [
      new AudibleProvider(),
      new OpenLibraryProvider(),
      new GoogleBooksProvider(),
    ];
    this.enrichmentProvider = options.enrichmentProvider ?? new AudnexusProvider();
    if (options.fuzzyThreshold  !== undefined) this.#fuzzyThreshold  = options.fuzzyThreshold;
    if (options.confidenceThreshold !== undefined) this.#confidenceThreshold = options.confidenceThreshold;
    if (options.language !== undefined) this.#language = options.language;
  }

  async resolve(query) {
    if (!query?.title) return null;

    const preferredLc = new Set(
      (query.preferredSeries || []).map(s => s && s.toLowerCase()).filter(Boolean)
    );

    const cacheKey = JSON.stringify({
      title: normalizeTitle(query.title),
      author: normalizeTitle(query.author || ''),
      duration: query.duration ?? null,
      preferred: [...preferredLc].sort(),
    });

    const cached = this.#cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.#cacheTtl) return cached.result;

    let best = null;

    const queryTitleNorm = normalizeTitle(query.title);
    for (const provider of this.providers) {
      let results;
      try { results = await provider.search(query); } catch { results = []; }

      // Score and filter each result. Accept either fuzzy match OR substring
      // containment (handles subtitle differences like "Moreta Dragonlady of
      // Pern" vs the canonical "Moreta").
      const scored = results
        .map(r => ({ ...r, _confidence: scoreResult(query, r), _provider: provider.name }))
        .filter(r => languageMatches(r.language, this.#language))
        .filter(r => {
          const rNorm = normalizeTitle(r.title);
          if (!rNorm) return false;
          if (levenshteinNorm(queryTitleNorm, rNorm) <= this.#fuzzyThreshold) return true;
          // Substring containment fallback — require ≥6 char match to avoid noise
          if (rNorm.length >= 6 && queryTitleNorm.includes(rNorm)) return true;
          if (queryTitleNorm.length >= 6 && rNorm.includes(queryTitleNorm)) return true;
          return false;
        })
        .sort((a, b) => b._confidence - a._confidence);

      if (!scored.length) continue;

      const top = preferSeries(scored, preferredLc, this.#preferTolerance);
      if (!best || top._confidence > best._confidence) best = top;
      if (top._confidence >= this.#confidenceThreshold) break;
    }

    if (!best) { this.#setCache(cacheKey, null); return null; }

    // Enrich with Audnexus when we have an ASIN (audiobook-specific data: chapters, narrator)
    if (best.asin && this.enrichmentProvider) {
      try {
        const enriched = await this.enrichmentProvider.search({ asin: best.asin });
        if (enriched.length) {
          const e = enriched[0];
          if (e.narrator && !best.narrator) best.narrator = e.narrator;
          if (e.series?.length && !best.series?.length) best.series = e.series;
          if (e.duration && !best.duration) best.duration = e.duration;
        }
      } catch { /* enrichment is best-effort */ }
    }

    const result = {
      provider:      best._provider,
      title:         best.title,
      author:        best.author,
      series:        best.series || [],
      narrator:      best.narrator || null,
      publishedYear: best.publishedYear || null,
      asin:          best.asin || null,
      confidence:    best._confidence,
    };

    this.#setCache(cacheKey, result);
    return result;
  }

  #setCache(key, result) {
    if (this.#cache.size >= this.#maxCacheSize) {
      // Evict oldest entry (Map preserves insertion order)
      this.#cache.delete(this.#cache.keys().next().value);
    }
    this.#cache.set(key, { result, ts: Date.now() });
  }

  clearCache() { this.#cache.clear(); }
}
