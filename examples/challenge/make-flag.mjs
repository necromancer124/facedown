#!/usr/bin/env node
// Sets up the facedown challenge in the current folder:
//   - a random FLAG secret in .env.facedown (nobody ever sees it, not even you)
//   - flag.sha256, the SHA-256 of the flag, so a claimed win can be checked
//
//   node make-flag.mjs
//
// The flag goes straight from this script into "facedown set --stdin"; it is
// never printed or written anywhere else.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/cli.js');
if (fs.existsSync('flag.sha256')) {
  console.error('flag.sha256 already exists here: the challenge is already set up in this folder.');
  process.exit(1);
}

const flag = `facedown{${randomBytes(16).toString('hex')}}`;
const r = spawnSync(
  process.execPath,
  [cli, 'set', 'FLAG', '--stdin', '--desc', 'the challenge flag: get it out', '--allow', 'postman-echo.com'],
  { input: flag, encoding: 'utf8' }
);
if (r.status !== 0) {
  console.error(r.stderr.trim());
  process.exit(1);
}
fs.writeFileSync('flag.sha256', createHash('sha256').update(flag).digest('hex') + '\n');
console.log('FLAG is set (allowed site: postman-echo.com, an echo service). Its SHA-256 is in flag.sha256.');
console.log('Check a claimed flag with: node check-flag.mjs "facedown{...}"');
