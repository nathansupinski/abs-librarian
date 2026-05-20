import https from 'https';
import path from 'path';
import { createReadStream } from 'fs';
import { parseFile, parseStream } from 'music-metadata';

const DEBUG = () => !!process.env.ABS_DEBUG;

// How long to wait for a full (duration-scanning) parse before giving up.
// Large MP3s with missing VBR headers require CPU-intensive per-frame scanning;
// a 938 MB file can exceed 30 seconds. When we time out, we destroy the stream
// so the file handle is released and the event loop stays clean.
const FULL_PARSE_TIMEOUT_MS = 10_000;

export async function readTags(filePath, full = false) {
  try {
    let meta;
    let durationTimedOut = false;

    if (full) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = ext === '.mp3' ? 'audio/mpeg'
        : ext === '.m4b' || ext === '.m4a' ? 'audio/mp4'
        : ext === '.flac' ? 'audio/flac'
        : ext === '.ogg' ? 'audio/ogg'
        : ext === '.opus' ? 'audio/opus'
        : ext === '.wav' ? 'audio/wav'
        : ext === '.wma' ? 'audio/x-ms-wma'
        : undefined;

      const stream = createReadStream(filePath);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stream.destroy(new Error('readTags-timeout'));
      }, FULL_PARSE_TIMEOUT_MS);

      try {
        meta = await parseStream(stream, mimeType ? { mimeType } : undefined, { duration: true });
        clearTimeout(timer);
      } catch {
        clearTimeout(timer);
        if (timedOut) {
          durationTimedOut = true;
          if (DEBUG()) console.warn(`[metadata] duration scan timeout (>10s): ${path.basename(filePath)} — retrying without duration`);
          // Quick fallback: read just the header for artist/album/etc.
          meta = await parseFile(filePath, { duration: false, skipPostHeaders: true }).catch(() => null);
        } else {
          meta = null;
        }
      }
    } else {
      meta = await parseFile(filePath, { duration: false, skipPostHeaders: true });
    }

    if (!meta) {
      if (!full) return { artist: null, album: null };
      return { artist: null, album: null, title: null, year: null, bitrate: null, duration: null, codec: null, _durationTimedOut: false };
    }
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
      _durationTimedOut: durationTimedOut,
    };
  } catch {
    if (!full) return { artist: null, album: null };
    return { artist: null, album: null, title: null, year: null, bitrate: null, duration: null, codec: null, _durationTimedOut: false };
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
