import path from 'path';
import { ScanRule } from './BaseRule.mjs';

/**
 * Handles folders named in the dot-separated convention:
 *   Firstname.Lastname.-.Series.Name.NN.-.Book.Title
 *
 * This was previously hardcoded to Lee Child only. Now it matches any author
 * whose book folders follow this naming pattern, provided the parsed author
 * name matches the parent directory (to avoid false positives).
 *
 * Examples matched:
 *   Lee.Child.-.Jack.Reacher.01.-.Killing.Floor
 *   Lee.Child.-Jack.Reacher.02.-.Die.Trying   (missing second dot before -)
 */
export default class DotSeparatedFormatRule extends ScanRule {
  get priority() { return 10; }

  async onBookDir(bookPath, bookName, authorName, authorPath, ctx) {
    const parsed = parseDotSeparated(bookName);
    if (!parsed) return false;

    // Sanity-check: parsed author should roughly match the containing dir
    if (!authorsMatch(parsed.author, authorName)) return false;

    if (!ctx.hasAudioRecursive(bookPath)) return true;

    const { series, num, title } = parsed;
    const seriesDir = path.join(ctx.root, authorName, series);
    const dest = path.join(seriesDir, `${num} - ${title}`);

    if (ctx.isDoubleNested(bookPath)) {
      const inner = path.join(bookPath, bookName);
      ctx.addMove(inner, dest,
        `dot-format → ${authorName}/${series}/${num} - ${title}/`,
        `Outer shell "${bookName}" will be empty — use --delete-empty-shells`);
      ctx.scanBookForJunk(inner, bookName, authorName, true);
    } else {
      ctx.addMove(bookPath, dest, `dot-format → ${authorName}/${series}/${num} - ${title}/`);
      ctx.scanBookForJunk(bookPath, bookName, authorName, true);
    }

    ctx.addLookup({
      filename: bookName,
      method: 'filename-parse',
      result: `${authorName} / ${series} / ${num} - ${title}`,
      confidence: 'high',
      notes: `Parsed from Firstname.Lastname.-.Series.NN.-.Title pattern`,
    });

    return true;
  }
}

/**
 * Parse a dot-separated folder name.
 * Returns { author, series, num, title } or null.
 *
 * Handles two minor variants:
 *   A.B.-.Series.NN.-.Title   (standard)
 *   A.B.-Series.NN.-.Title    (missing dot before dash on first separator)
 */
function parseDotSeparated(name) {
  // Standard: Author.Name.-.Series.Name.NN.-.Title.Words
  const m1 = name.match(/^([\w]+(?:\.[\w]+)+)\.-\.([\w]+(?:\.[\w]+)*?)\.(\d{2})\.-\.([\w.]+)$/i);
  if (m1) return build(m1[1], m1[2], m1[3], m1[4]);

  // Variant: Author.Name.-Series.Name.NN.-.Title.Words (missing dot before first dash)
  const m2 = name.match(/^([\w]+(?:\.[\w]+)+)\.-([\w]+(?:\.[\w]+)*?)\.(\d{2})\.-\.([\w.]+)$/i);
  if (m2) return build(m2[1], m2[2], m2[3], m2[4]);

  return null;
}

function build(authorDots, seriesDots, num, titleDots) {
  return {
    author: dotsToSpaces(authorDots),
    series: dotsToSpaces(seriesDots),
    num: num.padStart(2, '0'),
    title: dotsToSpaces(titleDots),
  };
}

function dotsToSpaces(s) {
  return s.replace(/\./g, ' ').trim();
}

/** Case-insensitive loose match — ignores periods and extra spaces. */
function authorsMatch(parsedAuthor, dirAuthor) {
  const norm = s => s.toLowerCase().replace(/[.\s]+/g, ' ').trim();
  return norm(parsedAuthor) === norm(dirAuthor);
}
