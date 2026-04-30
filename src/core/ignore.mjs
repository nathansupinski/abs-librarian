import fs from 'fs';
import { statOf } from './fs-utils.mjs';

export function loadIgnoreFile(filepath) {
  if (!statOf(filepath)) return [];
  return fs.readFileSync(filepath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function globToRegex(pattern) {
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*')
    .replace(/\?/g, '[^/]');
}

// Returns the matching rule string, or null.
// rules = array of rule strings from loadIgnoreFile
export function matchedIgnoreRule(relPath, isDir, rules) {
  for (const rule of rules) {
    const dirOnly = rule.endsWith('/');
    if (dirOnly && !isDir) continue;
    const p = rule.replace(/\/$/, '').replace(/^\//, '');
    const re = new RegExp(`^${globToRegex(p)}$`, 'i');
    if (p.includes('/')) {
      if (re.test(relPath)) return rule;
    } else {
      const parts = relPath.split('/');
      if (parts.some(part => re.test(part))) return rule;
    }
  }
  return null;
}
