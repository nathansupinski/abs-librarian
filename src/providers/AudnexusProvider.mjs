import https from 'https';
import { BaseProvider } from './BaseProvider.mjs';

// Token bucket: 100 req/min (Audnexus API limit)
let _tokens = 100;
let _lastRefill = Date.now();
async function throttle() {
  const now = Date.now();
  _tokens = Math.min(100, _tokens + (now - _lastRefill) / 600);
  _lastRefill = now;
  if (_tokens < 1) await new Promise(r => setTimeout(r, 600));
  _tokens -= 1;
}

function get(url, timeout) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'abs-librarian/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

export class AudnexusProvider extends BaseProvider {
  get name() { return 'Audnexus'; }

  async search({ title, author, asin }) {
    await throttle();
    let url;
    if (asin) {
      url = `https://audnexus.apis.mx/books?asin=${encodeURIComponent(asin)}`;
    } else if (title) {
      let q = `title=${encodeURIComponent(title)}`;
      if (author) q += `&author=${encodeURIComponent(author)}`;
      url = `https://audnexus.apis.mx/books?${q}`;
    } else {
      return [];
    }

    const body = await get(url, this.timeout);
    if (!body) return [];

    // Audnexus may return a single object or an array
    const items = Array.isArray(body) ? body : (body.asin ? [body] : []);
    return items.slice(0, 5).map(b => ({
      title:         b.title || null,
      author:        (b.authors || [])[0]?.name || null,
      subtitle:      null,
      narrator:      (b.narrators || [])[0]?.name || null,
      publisher:     b.publisherName || null,
      publishedYear: b.publishedYear ? String(b.publishedYear) : null,
      description:   b.summary || null,
      isbn:          null,
      asin:          b.asin || null,
      genres:        (b.genres || []).map(g => g.name || g).filter(Boolean),
      language:      null,
      duration:      b.runtime ? b.runtime * 60 : null,
      series:        b.seriesPrimary
        ? [{ series: b.seriesPrimary.name, sequence: b.seriesPrimary.position || null }]
        : [],
    }));
  }
}
