import fs from 'node:fs';

/** The version from package.json, the one place it is written down. */
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
