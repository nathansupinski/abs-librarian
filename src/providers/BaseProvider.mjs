export class BaseProvider {
  get name()    { return this.constructor.name; }
  get timeout() { return 12000; }

  // Returns ProviderResult[] — never throws, returns [] on failure.
  // ProviderResult: { title, author, subtitle, narrator, publisher, publishedYear,
  //   description, isbn, asin, genres, language, duration (seconds),
  //   series: [{ series, sequence }] }
  async search(_query) { return []; }
}
