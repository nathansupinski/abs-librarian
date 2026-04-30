import https from 'https';
import { parseFile } from 'music-metadata';

export async function readTags(filePath, full = false) {
  try {
    const meta = await parseFile(filePath, { duration: full, skipPostHeaders: !full });
    const c = meta.common;
    const f = meta.format;
    if (!full) return { artist: c.artist || c.albumartist || null, album: c.album || null };
    return {
      artist:   c.artist || c.albumartist || null,
      album:    c.album   || null,
      title:    c.title   || null,
      year:     c.year    || null,
      bitrate:  f.bitrate   ? Math.round(f.bitrate / 1000) : null,
      duration: f.duration  ? Math.round(f.duration)       : null,
      codec:    f.codec     || f.container                  || null,
    };
  } catch {
    if (!full) return { artist: null, album: null };
    return { artist: null, album: null, title: null, year: null, bitrate: null, duration: null, codec: null };
  }
}

// Prefers higher bitrate → more complete ID3 tags → larger file size.
export function recommendDuplicate(m1, m2, stat1, stat2) {
  if (m1.bitrate && m2.bitrate && m1.bitrate !== m2.bitrate)
    return m1.bitrate > m2.bitrate ? 'f1' : 'f2';
  const score = m => (m.artist ? 1 : 0) + (m.album ? 1 : 0) + (m.title ? 1 : 0) + (m.year ? 1 : 0);
  if (score(m1) !== score(m2)) return score(m1) > score(m2) ? 'f1' : 'f2';
  const sz1 = stat1?.size ?? 0, sz2 = stat2?.size ?? 0;
  if (sz1 !== sz2) return sz1 > sz2 ? 'f1' : 'f2';
  return null;
}

export function searchOpenLibrary(title) {
  return new Promise(resolve => {
    const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&fields=title,author_name&limit=3`;
    const req = https.get(url, { timeout: 12000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const docs = (JSON.parse(data).docs || []).slice(0, 3)
            .map(d => ({ title: d.title, author: (d.author_name || [])[0] || null }));
          const found = docs.length > 0 && docs[0].author;
          const ambiguous = docs.length > 1 &&
            docs[0].author?.toLowerCase() !== docs[1].author?.toLowerCase();
          resolve({ found: !!found, docs, ambiguous: !!ambiguous });
        } catch (e) {
          resolve({ found: false, docs: [], ambiguous: false, error: e.message });
        }
      });
    });
    req.on('error', e => resolve({ found: false, docs: [], ambiguous: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ found: false, docs: [], ambiguous: false, error: 'timeout' });
    });
  });
}
