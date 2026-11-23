#!/usr/bin/env node
// Used by .github/workflows/release.yml before publishing.
//
//   node scripts/release-check.mjs v1.2.3 [notes-file]
//
// Fails unless the tag matches the version in package.json and in both plugin
// files, and CHANGELOG.md has a section for that version. Writes that section
// to notes-file (for the GitHub release).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

export function releaseNotes(tag) {
  const problems = [];
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? '');
  if (!m) return { problems: [`"${tag}" is not a version tag like v1.2.3`] };
  const version = m[1];

  const versions = {
    'package.json': JSON.parse(read('package.json')).version,
    '.claude-plugin/plugin.json': JSON.parse(read('.claude-plugin/plugin.json')).version,
    '.claude-plugin/marketplace.json': JSON.parse(read('.claude-plugin/marketplace.json')).plugins[0].version,
  };
  for (const [file, v] of Object.entries(versions)) {
    if (v !== version) problems.push(`${file} says ${v}, the tag says ${version}`);
  }

  const changelog = read('CHANGELOG.md');
  const escaped = version.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const heading = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n`, 'm');
  const start = heading.exec(changelog);
  let notes = '';
  if (!start) {
    problems.push(`CHANGELOG.md has no "## [${version}]" section`);
  } else {
    const rest = changelog.slice(start.index + start[0].length);
    const end = rest.search(/^## \[/m);
    notes = (end === -1 ? rest : rest.slice(0, end)).trim();
    if (!notes) problems.push(`the CHANGELOG.md section for ${version} is empty`);
  }
  return { version, notes, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [tag, notesFile] = process.argv.slice(2);
  const { version, notes, problems } = releaseNotes(tag);
  if (problems.length) {
    for (const p of problems) console.error(`release-check: ${p}`);
    process.exit(1);
  }
  if (notesFile) fs.writeFileSync(notesFile, notes + '\n');
  console.log(`release-check: ${tag} is ready to publish as ${version}`);
}
