// Read a plain .env file, for `facedown import .env`.
//
// Supports what common .env files use: KEY=value, `export KEY=value`,
// "double quotes" (with \n, \t, \" and \\ escapes, may span lines),
// 'single quotes' and `backticks` (taken as they are, may span lines),
// inline comments after an unquoted value (" # ..."), and full-line comments.
// The comment line right above a key becomes its description.
// Values are never printed or returned to anything but the vault.

import { NAME_RE } from './format.js';

export function parseDotenv(text) {
  const entries = [];
  const skipped = []; // { name, why } — never contains a value
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  let note = '';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      note = '';
      continue;
    }
    if (line.startsWith('#')) {
      note = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      skipped.push({ name: `line ${i + 1}`, why: 'not KEY=value' });
      note = '';
      continue;
    }
    const name = m[1];
    let rest = m[2];
    let value;
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // Find the closing quote, possibly on a later line.
      let body = rest.slice(1);
      let end = findClose(body, quote);
      while (end === -1 && i + 1 < lines.length) {
        i++;
        body += '\n' + lines[i];
        end = findClose(body, quote);
      }
      if (end === -1) {
        skipped.push({ name, why: 'missing closing quote' });
        note = '';
        continue;
      }
      value = body.slice(0, end);
      if (quote === '"') {
        value = value.replace(/\\([nrt"\\])/g, (_m, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[c]);
      }
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }

    if (!NAME_RE.test(name)) skipped.push({ name, why: 'not a valid key name' });
    else if (!value) skipped.push({ name, why: 'empty value' });
    else entries.push({ name, value, description: note });
    note = '';
  }

  // A name listed twice: the last one wins, like most .env loaders.
  const byName = new Map(entries.map((e) => [e.name, e]));
  return { entries: [...byName.values()], skipped };
}

function findClose(body, quote) {
  for (let j = 0; j < body.length; j++) {
    if (quote === '"' && body[j] === '\\') {
      j++;
      continue;
    }
    if (body[j] === quote) return j;
  }
  return -1;
}
