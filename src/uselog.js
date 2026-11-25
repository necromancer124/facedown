// The use log: one line per time a key is used, so you can see what your AI
// (or you) did with your keys. Never the value.
//
//   ~/.facedown/use-log.jsonl
//   {"t":"2026-11-25T10:00:00Z","key":"GITHUB_TOKEN","via":"http_request","host":"api.github.com"}
//
// Suggested by u/Deynekin on r/mcp (#21). It lives in your home folder, not in
// the project, so it is never committed. It is capped so it can't grow forever.

import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './keystore.js';
import { createRedactor } from './redact.js';

const MAX_BYTES = 1024 * 1024;
const KEEP_LINES = 2000;

const logFile = () => path.join(homeDir(), 'use-log.jsonl');

/**
 * Record uses. entries: [{ key, via, host?, command?, count? }].
 * `secrets` (name -> value) masks any value that slipped into a command.
 * Never throws: a log problem must not stop the real work.
 */
export function logUse(entries, secrets = {}) {
  if (!entries.length) return;
  try {
    const t = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const clean = createRedactor(secrets);
    const lines = entries.map((e) => {
      const row = { t, key: e.key, via: e.via };
      if (e.host) row.host = e.host;
      if (e.count && e.count > 1) row.count = e.count;
      if (e.command) row.command = clean.all(String(e.command)).slice(0, 300);
      return JSON.stringify(row);
    });
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    if (fs.statSync(file).size > MAX_BYTES) {
      const keep = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-KEEP_LINES);
      fs.writeFileSync(file, keep.join('\n') + '\n', { mode: 0o600 });
    }
  } catch {
    // the log is a convenience
  }
}

/**
 * Log a run: each key handed to the command, plus (with --proxy) each site
 * the proxy actually sent a key to. With --proxy the program only had a
 * placeholder, so the run itself is logged as "run --proxy".
 */
export function logRun({ secrets, via, command, proxyUsed }) {
  const entries = Object.keys(secrets).map((key) => ({ key, via: proxyUsed ? `${via} --proxy` : via, command }));
  for (const [key, hosts] of Object.entries(proxyUsed ?? {})) {
    for (const [host, count] of Object.entries(hosts)) entries.push({ key, via: 'proxy', host, count });
  }
  logUse(entries, secrets);
}

/** Newest first. */
export function readUseLog({ key, limit = 30 } = {}) {
  let text = '';
  try {
    text = fs.readFileSync(logFile(), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.trim().split('\n').reverse()) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!key || row.key === key) rows.push(row);
    } catch {
      // skip a damaged line
    }
    if (rows.length >= limit) break;
  }
  return rows;
}

export function formatUseLog(rows) {
  if (!rows.length) return 'No uses logged yet.';
  return rows
    .map((r) => {
      const when = new Date(r.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const where = r.host ? ` to ${r.host}` : '';
      const times = r.count ? ` (${r.count}x)` : '';
      const cmd = r.command ? `  ${r.command}` : '';
      return `${when}  ${r.key}  ${r.via}${where}${times}${cmd}`;
    })
    .join('\n');
}
