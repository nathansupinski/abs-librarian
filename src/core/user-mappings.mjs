import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAPPINGS_FILE = path.join(PROJECT_ROOT, 'user-mappings.json');

export function loadUserMappings() {
  try {
    return JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf8'));
  } catch {
    return { knownMisplaced: {} };
  }
}
