// "There is a newer facedown" and "this version has a security problem".
//
// At most once a day facedown asks the npm registry for the latest version
// and whether the installed version is deprecated. A security release is
// marked by deprecating the old versions with a message that starts with
// "SECURITY" (only the package owner can do that, with npm's 2FA). The answer
// is cached in ~/.facedown/update-check.json.
//
// - Never updates anything by itself.
// - Offline or registry down: no notice, never an error.
// - FACEDOWN_NO_UPDATE_CHECK=1 (or a CI environment) turns it off.
// - FACEDOWN_BLOCK_INSECURE=1 makes facedown refuse to use secrets while the
//   installed version has a known security problem. Off by default: a hijacked
//   npm account must not be able to stop everyone, and offline use must work.

import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './keystore.js';
import { VERSION } from './version.js';

export const DEFAULT_UPDATE_URL = 'https://registry.npmjs.org/facedown';
const DAY_MS = 24 * 60 * 60 * 1000;
const CHANGELOG_URL = 'https://github.com/necromancer124/facedown/blob/main/CHANGELOG.md';
const HOW_TO_UPDATE = 'npm install -g facedown@latest, or update the Claude Code plugin';

export function updateCheckEnabled(env = process.env) {
  return env.FACEDOWN_NO_UPDATE_CHECK !== '1' && !env.CI;
}

export function blockInsecure(env = process.env) {
  return env.FACEDOWN_BLOCK_INSECURE === '1';
}

/** -1, 0 or 1. Pre-release versions (1.0.0-beta) count as older than the release. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre] = String(v).split('-', 2);
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0) ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre > y.pre ? 1 : -1;
}

const cacheFile = (home) => path.join(home, 'update-check.json');

function readCache(home, current) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(home), 'utf8'));
    return c && c.current === current && Number.isFinite(c.checkedAt) ? c : null;
  } catch {
    return null;
  }
}

function writeCache(home, data) {
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cacheFile(home), JSON.stringify(data) + '\n');
  } catch {
    // a read-only home folder only means we check again next time
  }
}

/** The registry's text is shown to people and agents: keep it short and on one line. */
const clean = (text) => (typeof text === 'string' ? text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) : null);

function summarize(c) {
  if (!c) return null;
  const deprecated = clean(c.deprecated) || null;
  return {
    current: c.current,
    latest: c.latest ?? null,
    newer: Boolean(c.latest) && compareVersions(c.latest, c.current) > 0,
    deprecated,
    security: deprecated && /^\s*security\b/i.test(deprecated) ? deprecated : null,
  };
}

/** What the last check found, without asking the registry. */
export function cachedUpdate({ home = homeDir(), current = VERSION } = {}) {
  return summarize(readCache(home, current));
}

/**
 * Ask the registry (at most once a day unless `force`). Resolves to
 * { current, latest, newer, deprecated, security }, or null if nothing is
 * known (offline on the first check). Never rejects.
 */
export async function checkForUpdate({
  home = homeDir(),
  current = VERSION,
  url = process.env.FACEDOWN_UPDATE_URL || DEFAULT_UPDATE_URL,
  timeoutMs = 3000,
  force = false,
  now = Date.now(),
} = {}) {
  const cached = readCache(home, current);
  if (!force && cached && now - cached.checkedAt < DAY_MS) return summarize(cached);
  try {
    const res = await fetch(url, {
      // The short form of the package info; it still lists `deprecated`.
      headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    const meta = await res.json();
    const latest = meta?.['dist-tags']?.latest;
    const deprecated = meta?.versions?.[current]?.deprecated;
    const data = {
      current,
      checkedAt: now,
      latest: typeof latest === 'string' ? latest : null,
      deprecated: typeof deprecated === 'string' ? deprecated : null,
    };
    writeCache(home, data);
    return summarize(data);
  } catch {
    return summarize(cached);
  }
}

/** One or two lines for people, or '' if there is nothing to say. */
export function updateNotice(info) {
  if (!info) return '';
  if (info.security) {
    return (
      `facedown: SECURITY: version ${info.current} has a known security problem: ${info.security}\n` +
      `facedown: update now (${HOW_TO_UPDATE}).`
    );
  }
  if (info.deprecated) {
    return `facedown: version ${info.current} is deprecated: ${info.deprecated} Update: ${HOW_TO_UPDATE}.`;
  }
  if (info.newer) {
    return `facedown: ${info.latest} is available (you have ${info.current}). Update: ${HOW_TO_UPDATE}. What changed: ${CHANGELOG_URL}`;
  }
  return '';
}

/** The error used when FACEDOWN_BLOCK_INSECURE=1 stops a command. */
export function insecureBlockMessage(info) {
  return (
    `refusing to use secrets: facedown ${info.current} has a known security problem (${info.security}). ` +
    `Update first (${HOW_TO_UPDATE}). FACEDOWN_BLOCK_INSECURE=1 is what makes this a hard stop.`
  );
}
