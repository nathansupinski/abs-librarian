const BOOK_WORD_NUMBERS = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';

/**
 * Strip series/book-number suffixes from audiobook folder names so the clean
 * title can be sent to metadata providers.
 *
 * Handles common Audible-style naming:
 *   "Columbus Day-Expeditionary Force, Book 1"          → "Columbus Day"
 *   "Armageddon_ Expeditionary Force, Book 8"           → "Armageddon"
 *   "Critical Mass: Expeditionary Force, Book 10"       → "Critical Mass"
 *   "Ascendant-Book 1"                                  → "Ascendant"
 *   "Storm Front (Dresden Files, #1)"                   → "Storm Front"
 *   "The Final Empire: Mistborn Book 1 (Unabridged)"    → "The Final Empire"
 *   "The Way of Kings-Book One of The Stormlight Archive" → "The Way of Kings"
 *   "Oathbringer-Book Three of The Stormlight Archive"  → "Oathbringer"
 */
export function cleanBookTitle(name) {
  let t = name.trim();
  // Strip trailing edition/format markers in parens/brackets first
  // "(Unabridged)", "[Audiobook]", "(Special Edition)" etc.
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(/\s*[\[(][^\])]*(unabridged|audiobook|audio drama|special edition|anniversary)[^\])]*[\])]\s*$/i, '').trim();
    if (t === before) break;
  }
  // "Title[-_:] Series Name, Book N[...]"
  t = t.replace(/\s*[-_:]\s*.+?,\s*Book\s+\d+(?:\.\d+)?.*$/i, '');
  // "Title[-_:] Series Name Book N[...]"  (no comma — e.g. "Mistborn Book 1")
  t = t.replace(/\s*[-_:]\s*[^-_:,]+?\s+Book\s+\d+(?:\.\d+)?.*$/i, '');
  // "Title[-_:] Book N[...]"  (no series name before book number)
  t = t.replace(/\s*[-_:]\s*Book\s+\d+(?:\.\d+)?.*$/i, '');
  // "Title-Book One of Series Name" (textual number form)
  t = t.replace(new RegExp(`\\s*[-_:]\\s*Book\\s+${BOOK_WORD_NUMBERS}(?:\\s+of\\s+.+)?$`, 'i'), '');
  // "Title (Series, #N)" or "(Series, Book N)" in trailing parens/brackets
  t = t.replace(/\s*[\[(][^\])]*(Book\s+\d+|#\s*\d+)[^\])]*[\])]\s*$/i, '');
  // Leading "Book N - Title" / "Vol N - Title" / "Volume N - Title"
  t = t.replace(/^(?:Book|Vol(?:ume)?|Part|Chapter|Episode)\s+\d+(?:\.\d+)?\s*[-–:]\s*/i, '');
  return t.trim() || name;
}

/**
 * Parse embedded series info from folder names like:
 *   "Columbus Day-Expeditionary Force, Book 1"
 *   "Armageddon_ Expeditionary Force, Book 8"
 *   "Defying Destiny:The War of Broken Mirrors, Book 3"
 *   "Ascendant-Book 1"            (series name unknown, position known)
 *   "Book 2 - Dragonsong"         (leading "Book N - Title" — position known)
 *
 * Returns { cleanTitle, series, sequence } or null.
 * `series` is null when the folder gives position but not series name.
 */
export function parseEmbeddedSeries(name) {
  // "Title[-_:] Series Name, Book N"
  const m = name.match(/^(.+?)\s*[-_:]\s*(.+?),\s*Book\s+(\d+(?:\.\d+)?).*$/i);
  if (m) return { cleanTitle: m[1].trim(), series: m[2].trim(), sequence: m[3] };

  // "Title[-_:] Book N"  (no series name)
  const m2 = name.match(/^(.+?)\s*[-_:]\s*Book\s+(\d+(?:\.\d+)?).*$/i);
  if (m2) return { cleanTitle: m2[1].trim(), series: null, sequence: m2[2] };

  // "Book N - Title"  (leading position prefix, no series name)
  const m3 = name.match(/^(?:Book|Vol(?:ume)?|Part)\s+(\d+(?:\.\d+)?)\s*[-–:]\s*(.+)$/i);
  if (m3) return { cleanTitle: m3[2].trim(), series: null, sequence: m3[1] };

  return null;
}
