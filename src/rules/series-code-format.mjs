import path from 'path';
import { ScanRule } from './BaseRule.mjs';

/**
 * Handles the M.C. Beaton / Marion Chesney folder naming conventions.
 *
 * Three patterns handled (in priority order):
 *   1. "Agatha Raisin NN - Title"
 *   2. "M C Beaton - AR## Title [NofM]" / "M C Beaton - HM## Title [NofM]"
 *   3. Any folder with a NofM disc pattern as fallback
 *
 * The check is entirely self-contained (based on folder name), so no
 * authorName guard is needed — the patterns are specific enough not to
 * false-positive on other authors.
 */
export default class SeriesCodeFormatRule extends ScanRule {
  get priority() { return 20; }

  async onBookDir(bookPath, bookName, authorName, authorPath, ctx) {
    if (!ctx.hasAudioRecursive(bookPath)) return false;

    // --- Pattern 1: "Agatha Raisin NN - Title" ---
    const ar = parseAgathRaisin(bookName);
    if (ar) {
      ctx.addMove(
        bookPath,
        path.join(authorPath, 'Agatha Raisin', `${ar.num} - ${ar.title}`),
        `${authorName} → Agatha Raisin/${ar.num} - ${ar.title}/`
      );
      ctx.addLookup({
        filename: bookName, method: 'filename-parse',
        result: `${authorName} / Agatha Raisin / ${ar.num} - ${ar.title}`,
        confidence: 'high', notes: '',
      });
      ctx.scanBookForJunk(bookPath, bookName, authorName, true);
      return true;
    }

    // --- Pattern 2: "M C Beaton - AR##/HM## Title [NofM]" ---
    const mcb = parseMCBeaton(bookName);
    if (mcb) {
      const bookDest = path.join(authorPath, mcb.series, `${mcb.num} - ${mcb.title}`);
      if (mcb.disc !== null) {
        const discDest = path.join(bookDest, `Disc ${mcb.disc}`);
        const note = `Disc ${mcb.disc}${mcb.totalDiscs ? ' of ' + mcb.totalDiscs : ''} for "${mcb.title}". Book may be incomplete.`;
        ctx.addBestGuess(bookPath, discDest, path.join(ctx.root, '_NeedsReview', bookName),
          `${authorName} partial disc → ${mcb.series}/${mcb.num} - ${mcb.title}/Disc ${mcb.disc}/`, note);
        ctx.addLookup({
          filename: bookName, method: 'filename-parse',
          result: `${authorName} / ${mcb.series} / ${mcb.num} - ${mcb.title} / Disc ${mcb.disc}`,
          confidence: 'high', notes: note,
        });
      } else {
        ctx.addMove(bookPath, bookDest, `${authorName} → ${mcb.series}/${mcb.num} - ${mcb.title}/`);
        ctx.addLookup({
          filename: bookName, method: 'filename-parse',
          result: `${authorName} / ${mcb.series} / ${mcb.num} - ${mcb.title}`,
          confidence: 'high', notes: '',
        });
        ctx.scanBookForJunk(bookPath, bookName, authorName, true);
      }
      return true;
    }

    // --- Pattern 3: any NofM disc pattern, use ID3 for title ---
    const discInfo = extractDiscInfo(bookName);
    if (discInfo) {
      const af = ctx.listDir(bookPath).find(ctx.isAudio);
      let guessTitle = bookName;
      if (af) {
        const tags = await ctx.readTags(path.join(bookPath, af));
        if (tags.album) guessTitle = tags.album;
      }
      ctx.addBestGuess(
        bookPath,
        path.join(authorPath, guessTitle, `Disc ${discInfo.disc}`),
        path.join(ctx.root, '_NeedsReview', bookName),
        `${authorName} disc folder — partially parsed`,
        `Disc ${discInfo.disc} of ${discInfo.totalDiscs}. Guessed title: "${guessTitle}".`
      );
      ctx.addLookup({
        filename: bookName, method: 'id3+filename',
        result: `${authorName} / ${guessTitle} / Disc ${discInfo.disc}`,
        confidence: 'low', ambiguous: true,
        notes: 'Series code not recognized; using ID3 album tag',
      });
      return true;
    }

    return false;
  }
}

// "Agatha Raisin NN - Title"
function parseAgathRaisin(name) {
  const m = name.match(/^Agatha Raisin\s+(\d{1,2})\s+-\s+(.+)$/i);
  return m ? { num: m[1].padStart(2, '0'), title: m[2].trim() } : null;
}

// "M C Beaton - AR## Title [NofM]" or "M C Beaton - HM## Title [NofM]"
function parseMCBeaton(name) {
  const cleaned = name.replace(/^Hamish flood\s+/i, '');
  const ar = cleaned.match(/^M[. ]C[. ]\s*Beaton\s+-\s+AR(\d{2})\s+(.+?)(?:\s+(\d+)of(\d+))?$/i);
  if (ar) return {
    series: 'Agatha Raisin',
    num: ar[1].padStart(2, '0'), title: ar[2].trim(),
    disc: ar[3] ? +ar[3] : null, totalDiscs: ar[4] ? +ar[4] : null,
  };
  const hm = cleaned.match(/^M[. ]C[. ]\s*Beaton\s+-\s+HM(\d{2})\s+(.+?)(?:\s+(\d+)of(\d+))?$/i);
  if (hm) return {
    series: 'Hamish Macbeth',
    num: hm[1].padStart(2, '0'), title: hm[2].trim(),
    disc: hm[3] ? +hm[3] : null, totalDiscs: hm[4] ? +hm[4] : null,
  };
  return null;
}

function extractDiscInfo(name) {
  const m = name.match(/(\d+)of(\d+)/i);
  return m ? { disc: +m[1], totalDiscs: +m[2] } : null;
}
