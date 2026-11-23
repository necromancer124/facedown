// The public surface promised in docs/STABILITY.md. If one of these tests
// fails, something people rely on disappeared: put it back, or (from 1.0 on)
// it needs a new major version and a CHANGELOG entry.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(root, 'src', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'facedown-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'facedown-proj-'));
const env = { ...process.env, FACEDOWN_HOME: home, FACEDOWN_NO_WINDOW: '1' };
delete env.FACEDOWN_FILE;
delete env.FACEDOWN_DIR;

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: 'utf8' });
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const COMMANDS = {
  init: [],
  set: ['--desc', '--allow', '--stdin', '--allow-short'],
  list: ['--json'],
  ls: [],
  rm: [],
  remove: [],
  allow: ['--clear'],
  check: [],
  run: ['--keys', '--all-keys', '--strict', '--quiet'],
  export: [],
  import: [],
  migrate: [],
  mcp: [],
  help: [],
};

const TOOLS = {
  list_keys: { required: [], optional: [] },
  add_key: { required: ['name'], optional: ['description', 'allow'] },
  run_with_secrets: { required: ['command', 'keys'], optional: ['cwd', 'timeout_seconds'] },
  http_request: { required: ['url'], optional: ['method', 'headers', 'body'] },
  remove_key: { required: ['name'], optional: [] },
  allow_hosts: { required: ['name'], optional: ['add', 'remove'] },
};

const SLASH_COMMANDS = ['addKey', 'keys', 'removeKey', 'allowSite', 'removeSite'];

test('surface: every CLI command exists and is in the help with its flags', () => {
  const help = cli('help').stdout;
  for (const [command, flags] of Object.entries(COMMANDS)) {
    if (command !== 'mcp') {
      // Run each with no arguments: a usage error is fine, "unknown command" is not.
      const r = cli(command);
      assert.doesNotMatch(r.stderr, /unknown command/, `facedown ${command} disappeared`);
    }
    if (!['ls', 'remove', 'help'].includes(command)) assert.match(help, new RegExp(`facedown ${command}\\b`), `${command} is not in the help`);
    for (const flag of flags) assert.ok(help.includes(flag), `${command} ${flag} is not in the help`);
  }
  assert.match(cli('--version').stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('surface: the CLI refuses every command that would print a value', () => {
  for (const command of ['get', 'show', 'print', 'reveal', 'export-plain', 'cat', 'decrypt', 'dump']) {
    assert.match(cli(command, 'X').stderr, /unknown command/, `"${command}" must not exist`);
  }
});

test('surface: every MCP tool and its arguments are still there', async () => {
  const { TOOLS: actual } = await import('../src/mcp.js');
  const byName = Object.fromEntries(actual.map((t) => [t.name, t]));
  for (const [name, { required, optional }] of Object.entries(TOOLS)) {
    const tool = byName[name];
    assert.ok(tool, `the MCP tool ${name} disappeared`);
    const props = Object.keys(tool.inputSchema.properties ?? {});
    for (const arg of [...required, ...optional]) assert.ok(props.includes(arg), `${name}.${arg} disappeared`);
    // A new required argument would break existing callers.
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), [...required].sort(), `${name}: required arguments changed`);
  }
  for (const tool of actual) {
    assert.doesNotMatch(tool.name, /reveal|get_value|decrypt|export|show/, `${tool.name}: no tool may return a value`);
  }
});

test('surface: the plugin slash commands exist and the plugin starts the MCP server', () => {
  for (const name of SLASH_COMMANDS) assert.ok(fs.existsSync(path.join(root, '.claude', 'commands', `${name}.md`)), `/${name} disappeared`);
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.deepEqual(plugin.mcpServers.facedown.args.slice(-1), ['mcp']);
});

test('surface: one version everywhere (package.json, plugin, marketplace, changelog)', () => {
  const { version } = JSON.parse(read('package.json'));
  assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).version, version, 'plugin.json version');
  assert.equal(JSON.parse(read('.claude-plugin/marketplace.json')).plugins[0].version, version, 'marketplace.json version');
  assert.match(read('CHANGELOG.md'), new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm'), `CHANGELOG.md has no ${version} section`);
});

test('surface: the documented environment variables are the ones the code reads', () => {
  const documented = new Set(read('docs/STABILITY.md').match(/FACEDOWN_[A-Z_]+/g));
  const src = fs.readdirSync(path.join(root, 'src')).map((f) => read(`src/${f}`)).join('\n');
  // Only the variables a user sets; the window scripts' own variables are internal.
  const used = new Set(
    [...src.matchAll(/process\.env\.(FACEDOWN_[A-Z_]+)/g)].map((m) => m[1]).concat(read('.claude-plugin/plugin.json').match(/FACEDOWN_[A-Z_]+/g))
  );
  for (const name of used) assert.ok(documented.has(name), `${name} is read by the code but not in docs/STABILITY.md`);
  for (const name of documented) assert.ok(used.has(name), `${name} is documented but nothing reads it`);
});

test('release check: the tag must match every version and have changelog notes', async () => {
  const { releaseNotes } = await import('../scripts/release-check.mjs');
  const { version } = JSON.parse(read('package.json'));
  const ok = releaseNotes(`v${version}`);
  assert.deepEqual(ok.problems, []);
  assert.ok(ok.notes.length > 20);
  assert.match(releaseNotes('v99.0.0').problems.join('\n'), /package\.json says .*the tag says 99\.0\.0/);
  assert.match(releaseNotes('v99.0.0').problems.join('\n'), /no "## \[99\.0\.0\]" section/);
  assert.match(releaseNotes('1.0.0').problems[0], /not a version tag/);
});
