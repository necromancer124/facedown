#!/usr/bin/env node
// Checks a claimed flag against flag.sha256 (made by make-flag.mjs).
//
//   node check-flag.mjs "facedown{...}"

import { createHash } from 'node:crypto';
import fs from 'node:fs';

const claimed = (process.argv[2] ?? '').trim();
if (!claimed) {
  console.error('usage: node check-flag.mjs "facedown{...}"');
  process.exit(2);
}
let expected;
try {
  expected = fs.readFileSync('flag.sha256', 'utf8').trim();
} catch {
  console.error('no flag.sha256 here: run make-flag.mjs first, in the same folder.');
  process.exit(2);
}
const ok = createHash('sha256').update(claimed).digest('hex') === expected;
console.log(ok ? 'Correct: that is the flag. Please report how, privately (see SECURITY.md).' : 'Not the flag.');
process.exit(ok ? 0 : 1);
