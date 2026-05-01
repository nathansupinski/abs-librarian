import { readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RULES_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['BaseRule.mjs', 'loader.mjs']);

export async function loadRules() {
  const files = readdirSync(RULES_DIR)
    .filter(f => f.endsWith('.mjs') && !SKIP.has(f))
    .sort();

  const rules = [];
  for (const file of files) {
    const mod = await import(path.join(RULES_DIR, file));
    if (!mod.default) continue;
    rules.push(new mod.default());
  }

  rules.sort((a, b) => a.priority - b.priority);
  return rules;
}
