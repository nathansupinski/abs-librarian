import https from 'https';
import { BaseProvider } from './BaseProvider.mjs';

function stripHtml(str) {
  return str ? str.replace(/<[^>]*>/g, '').trim() : null;
}

export class AudibleProvider extends BaseProvider {
  get name() { return 'Audible'; }

  search({ title, author }) {
    return new Promise(resolve => {
      let keywords = encodeURIComponent(title);
      if (author) keywords += `+${encodeURIComponent(author)}`;
      const url = `https://api.audible.com/1.0/catalog/products` +
        `?keywords=${keywords}` +
        `&response_groups=product_desc,media,contributors,series` +
        `&num_results=5`;

      const req = https.get(url, { timeout: this.timeout, headers: { 'User-Agent': 'abs-librarian/1.0' } }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const products = JSON.parse(data).products || [];
            resolve(products.slice(0, 5).map(p => ({
              title:         p.title || null,
              author:        (p.authors || [])[0]?.name || null,
              subtitle:      p.subtitle || null,
              narrator:      (p.narrators || [])[0]?.name || null,
              publisher:     p.publisher_name || null,
              publishedYear: p.release_date ? p.release_date.slice(0, 4) : null,
              description:   stripHtml(p.merchandising_summary),
              isbn:          null,
              asin:          p.asin || null,
              genres:        [],
              language:      p.language || null,
              duration:      p.runtime_length_min ? p.runtime_length_min * 60 : null,
              series:        (p.series || []).map(s => ({ series: s.title, sequence: s.sequence || null })),
            })));
          } catch {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });
  }
}
