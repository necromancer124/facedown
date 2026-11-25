// `facedown doctor`: check the whole setup and say what's wrong, in plain words.
// Never shows a value.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDotenv } from './dotenv.js';
import { FILE_NAME, LEGACY_FILE_NAME } from './format.js';
import { canPromptInWindow } from './prompt.js';
import { checkForUpdate, updateCheckEnabled } from './update.js';
import { MIN_VALUE_LENGTH, Vault, describeAge } from './vault.js';
import { VERSION } from './version.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
const OLD_KEY_DAYS = 180;

/** Start the MCP server like a client would and list its tools. */
function probeMcp(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'mcp'], {
      env: { ...process.env, FACEDOWN_NO_UPDATE_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    const done = (result) => {
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, why: `no answer within ${timeoutMs / 1000} s` }), timeoutMs);
    child.on('error', (e) => done({ ok: false, why: e.message }));
    child.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.includes('"id":2'));
      if (!line) return;
      try {
        const tools = JSON.parse(line).result.tools.map((t) => t.name);
        done({ ok: true, tools });
      } catch {
        done({ ok: false, why: 'unexpected answer' });
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  });
}

/**
 * Run every check. Returns { lines: [{ level: 'ok'|'warn'|'fail', text }], failed }.
 * `skipNetwork` and `skipMcp` are for tests.
 */
export async function runDoctor({ skipNetwork = false, skipMcp = false } = {}) {
  const lines = [];
  const ok = (text) => lines.push({ level: 'ok', text });
  const warn = (text) => lines.push({ level: 'warn', text });
  const fail = (text) => lines.push({ level: 'fail', text });

  // Node and facedown itself
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node}: facedown needs Node 20 or newer`);

  if (skipNetwork || !updateCheckEnabled()) {
    ok(`facedown ${VERSION} (update check skipped)`);
  } else {
    const info = await checkForUpdate();
    if (!info) warn(`facedown ${VERSION}: could not check for updates (offline?)`);
    else if (info.security) fail(`facedown ${VERSION} has a known security problem: ${info.security}. Update now.`);
    else if (info.newer) warn(`facedown ${VERSION}: ${info.latest} is available (npm install -g facedown@latest)`);
    else ok(`facedown ${VERSION} (latest)`);
  }

  // The vault
  const file = Vault.find();
  const folder = file ? path.dirname(file) : process.cwd();
  if (!file) {
    warn(`No vault here or in a parent folder. "facedown set NAME" (or /addKey) creates ${FILE_NAME}.`);
  } else {
    let vault;
    try {
      vault = Vault.load(file);
      ok(`Vault: ${file} (${vault.entries.size} key${vault.entries.size === 1 ? '' : 's'})`);
    } catch (err) {
      fail(`Vault ${file} cannot be read: ${err.message}`);
    }
    if (vault && path.basename(file) === LEGACY_FILE_NAME) warn(`The vault still has its old name (${LEGACY_FILE_NAME}). "facedown migrate" renames it.`);

    if (vault) {
      let keyOk = false;
      try {
        vault.key();
        keyOk = true;
        ok('Unlock key found on this computer');
      } catch (err) {
        fail(err.message);
      }
      if (keyOk && vault.entries.size) {
        const broken = [];
        const short = [];
        const old = [];
        for (const [name, entry] of vault.entries) {
          try {
            if (vault.inspect(name).length < MIN_VALUE_LENGTH) short.push(name);
          } catch {
            broken.push(name);
          }
          if (entry.setAt && Date.now() - Date.parse(entry.setAt) > OLD_KEY_DAYS * 86_400_000) old.push(`${name} (${describeAge(entry.setAt)})`);
        }
        if (broken.length) fail(`Cannot decrypt ${broken.join(', ')}: changed by hand, or made on another computer. See docs/FAQ.md.`);
        else ok(vault.entries.size === 1 ? 'The key decrypts' : `All ${vault.entries.size} keys decrypt`);
        if (short.length) warn(`Short values (under ${MIN_VALUE_LENGTH} characters, hidden less well): ${short.join(', ')}`);
        if (old.length) warn(`Not changed for a long time, consider rotating: ${old.join(', ')}`);
        const noSites = vault.list().filter((k) => !k.allow.length).map((k) => k.name);
        if (noSites.length) ok(`Keys that may go to no site yet (fine for run, not for http_request): ${noSites.join(', ')}`);
      }
    }
  }

  // A plain .env file next to the vault still holds secrets in plain text
  for (const name of ['.env', '.env.local']) {
    const p = path.join(folder, name);
    if (!fs.existsSync(p)) continue;
    let count = 0;
    try {
      count = parseDotenv(fs.readFileSync(p, 'utf8')).entries.length;
    } catch {
      // unreadable: ignore
    }
    if (count) warn(`${name} holds ${count} value${count === 1 ? '' : 's'} in plain text. "facedown import ${name}" moves them into the vault.`);
  }

  // Windows for typing values and confirming
  if (process.platform === 'win32') {
    if (!canPromptInWindow()) {
      warn('Windows are switched off (FACEDOWN_NO_WINDOW=1): anything that needs your OK will be refused.');
    } else {
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true, timeout: 15000 });
      if (ps.status === 0) ok('Password and confirmation windows can open');
      else fail('PowerShell could not start, so the password and confirmation windows cannot open');
    }
  } else {
    warn(`${process.platform}: no windows yet; values are typed in a terminal (untested on this system)`);
  }

  // The MCP server
  if (!skipMcp) {
    const mcp = await probeMcp();
    if (mcp.ok && mcp.tools.length === 6) ok(`MCP server starts and lists its ${mcp.tools.length} tools`);
    else if (mcp.ok) warn(`MCP server starts but lists ${mcp.tools.length} tools: ${mcp.tools.join(', ')}`);
    else fail(`MCP server does not start: ${mcp.why}`);
  }

  for (const [name, on] of [
    ['FACEDOWN_STRICT', process.env.FACEDOWN_STRICT === '1'],
    ['FACEDOWN_BLOCK_INSECURE', process.env.FACEDOWN_BLOCK_INSECURE === '1'],
  ]) {
    if (on) ok(`${name}=1 is on`);
  }

  return { lines, failed: lines.some((l) => l.level === 'fail') };
}

const MARK = { ok: '✔', warn: '!', fail: '✖' };

export function formatDoctor({ lines, failed }) {
  const body = lines.map((l) => `${MARK[l.level]} ${l.text}`).join('\n');
  const end = failed ? '\nSomething needs fixing (✖ above).' : '\nAll good.';
  return body + end;
}
