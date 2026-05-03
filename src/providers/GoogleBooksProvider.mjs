import https from 'https';
import { BaseProvider } from './BaseProvider.mjs';

export class GoogleBooksProvider extends BaseProvider {
  get name() { return 'GoogleBooks'; }

  search({ title, author }) {
    return new Promise(resolve => {
      let q = `intitle:${encodeURIComponent(title)}`;
      if (author) q += `+inauthor:${encodeURIComponent(author)}`;
      const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5&printType=books`;

      const req = https.get(url, { timeout: this.timeout }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const items = JSON.parse(data).items || [];
            resolve(items.slice(0, 5).map(item => {
              const v = item.volumeInfo || {};
              const isbn13 = (v.industryIdentifiers || [])
                .find(i => i.type === 'ISBN_13')?.identifier || null;
              const isbn10 = (v.industryIdentifiers || [])
                .find(i => i.type === 'ISBN_10')?.identifier || null;
              return {
                title:         v.title || null,
                author:        (v.authors || [])[0] || null,
                subtitle:      v.subtitle || null,
                narrator:      null,
                publisher:     v.publisher || null,
                publishedYear: v.publishedDate ? v.publishedDate.slice(0, 4) : null,
                description:   v.description || null,
                isbn:          isbn13 || isbn10,
                asin:          null,
                genres:        v.categories || [],
                language:      v.language || null,
                duration:      null,
                series:        [],
              };
            }));
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
