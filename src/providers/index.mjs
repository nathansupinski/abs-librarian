import { MetadataResolver } from './MetadataResolver.mjs';

export { BaseProvider }      from './BaseProvider.mjs';
export { OpenLibraryProvider } from './OpenLibraryProvider.mjs';
export { GoogleBooksProvider } from './GoogleBooksProvider.mjs';
export { AudibleProvider }   from './AudibleProvider.mjs';
export { AudnexusProvider }  from './AudnexusProvider.mjs';
export { MetadataResolver }  from './MetadataResolver.mjs';

export const resolver = new MetadataResolver();
