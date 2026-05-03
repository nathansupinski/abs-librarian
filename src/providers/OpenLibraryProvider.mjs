import https from 'https';
import { BaseProvider } from './BaseProvider.mjs';

export class OpenLibraryProvider extends BaseProvider {
  get name() { return 'OpenLibrary'; }

  search({ title, author }) {
    return new Promise(resolve => {
      let q = `title=${encodeURIComponent(title)}`;
      if (author) q += `&author=${encodeURIComponent(author)}`;
      q += '&fields=title,author_name,isbn,first_publish_year&limit=5';
      const url = `https://openlibrary.org/search.json?${q}`;

      const req = https.get(url, { timeout: this.timeout }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const docs = (JSON.parse(data).docs || []).slice(0, 5);
            resolve(docs.map(d => ({
              title:         d.title || null,
              author:        (d.author_name || [])[0] || null,
              subtitle:      null,
              narrator:      null,
              publisher:     null,
              publishedYear: d.first_publish_year ? String(d.first_publish_year) : null,
              description:   null,
              isbn:          (d.isbn || [])[0] || null,
              asin:          null,
              genres:        [],
              language:      null,
              duration:      null,
              series:        [],
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
