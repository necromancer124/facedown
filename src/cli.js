#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { formatDoctor, runDoctor } from './doctor.js';
import { parseDotenv } from './dotenv.js';
import { FILE_NAME, LEGACY_FILE_NAME } from './format.js';
import { serveMcp } from './mcp.js';
import {
  PromptCancelled,
  askPassphrase,
  canPromptInTerminal,
  canPromptInWindow,
  confirmAction,
  confirmDelete,
  confirmNewHosts,
  describeKeyForPrompt,
  promptTerminal,
  promptWindow,
} from './prompt.js';
import { MIN_REDACT_LENGTH, describeHits, leakMessage } from './redact.js';
import { describeUse, startSecretProxy } from './proxy.js';
import { findKeyExpansions, keyOnCommandLineMessage, runStreaming } from './run.js';
import { EXPORT_FORMAT, MIN_PASSPHRASE_LENGTH, decryptExport, encryptExport } from './transfer.js';
import { MIN_VALUE_LENGTH, Vault, withLock } from './vault.js';
import {
  blockInsecure,
  checkForUpdate,
  insecureBlockMessage,
  updateCheckEnabled,
  updateNotice,
} from './update.js';
import { VERSION } from './version.js';

const LEAK_EXIT_CODE = 97;

const HELP = `facedown ${VERSION} - a .env file for AI agents

The AI can see the NAMES of your secrets and use them, but never the values.

Usage:
  facedown init                         create a ${FILE_NAME} vault in this folder
  facedown set NAME [options]           add or replace a secret (hidden input)
      --desc "text"                      what the secret is for (the AI can read this)
      --allow host1,host2                hosts it may be sent to in web requests
      --stdin                            read the value from stdin instead of asking
      --allow-short                      accept a value shorter than 8 characters
  facedown list [--json]                show names, notes and allowed hosts
  facedown rm NAME                      delete a secret (asks you to confirm)
  facedown allow NAME host [host...]    set the hosts a secret may be sent to
                                         (adding a host asks you to confirm)
  facedown allow NAME --clear           allow no hosts
  facedown check [NAME...]              test that secrets decrypt; shows length
                                         and a fingerprint, never the value
  facedown run --keys A,B [--strict] [--quiet] [--proxy] -- command
                                         run a command with secrets as env vars.
                                         --keys can be left out in a terminal
                                         (every key is passed); otherwise use
                                         --all-keys to pass every key on purpose.
                                         --proxy (experimental): the program gets
                                         placeholders; a local proxy puts the real
                                         key only into requests to allowed sites.
                                         Printing a secret is fine for logs: the
                                         output shows ***NAME*** instead of the
                                         value, plus a one-line note (--quiet
                                         drops the note). With --strict (or
                                         FACEDOWN_STRICT=1) printing a secret
                                         fails the run with exit code 97.
  facedown export FILE                  copy every secret into FILE, encrypted with
                                         a passphrase you choose (to move a vault
                                         to another computer). Asks in a window.
  facedown import FILE                  add the secrets from an export (asks for
                                         the passphrase), or move the keys of a
                                         plain .env file into the vault and offer
                                         to delete it (--keep: don't ask)
  facedown doctor                       check the setup and say what's wrong
  facedown migrate                      rename an old .aienv vault (from before
                                         the rename) to ${FILE_NAME}
  facedown mcp                          start the MCP server (for AI agents)

There is no command that prints a secret value, on purpose.
`;

function takeOption(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  if (i + 1 >= args.length) throw new Error(`${flag} needs a value`);
  return args.splice(i, 2)[1];
}

function takeFlag(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

async function cmdSet(args) {
  const description = takeOption(args, '--desc');
  const allowText = takeOption(args, '--allow');
  const fromStdin = takeFlag(args, '--stdin');
  const allowShort = takeFlag(args, '--allow-short');
  const [name, extra] = args;
  if (!name) throw new Error('usage: facedown set NAME [--desc "text"] [--allow host,host]');
  if (extra !== undefined) {
    throw new Error(
      'do not put the value on the command line (it would be saved in your shell history). ' +
        `Run "facedown set ${name}" and type it when asked.`
    );
  }
  const allow = allowText === undefined ? undefined : allowText.split(',');

  const existed = Boolean(Vault.find());
  const vault = Vault.openOrInit();
  if (!existed) console.error(`Created ${vault.file}`);

  let value;
  if (fromStdin) {
    value = await readStdin();
  } else if (canPromptInTerminal()) {
    value = await promptTerminal(`Value for ${name} (hidden): `);
  } else if (canPromptInWindow()) {
    console.error(`A password window opened on your screen for ${name}.`);
    const old = vault.entries.get(name);
    value = await promptWindow(
      name,
      describeKeyForPrompt({
        description: description ?? old?.description,
        allow: allow ?? old?.allow,
        previousAllow: old ? vault.trustedAllow(name) : [],
        replacing: Boolean(old),
      })
    );
  } else {
    throw new Error(`no terminal to ask in. Run "facedown set ${name}" yourself in a terminal.`);
  }

  vault.set(name, value, { description, allow, allowShort });
  console.log(`Saved ${name}.`);
  if (value.length < MIN_REDACT_LENGTH) {
    console.error(`Warning: ${name} is shorter than ${MIN_REDACT_LENGTH} characters, so it is not hidden in program output at all.`);
  } else if (value.length < MIN_VALUE_LENGTH) {
    console.error(`Warning: ${name} is short, so where it is hidden in output, the hiding can give it away.`);
  }
}

function cmdList(args) {
  const keys = Vault.open().list();
  if (takeFlag(args, '--json')) {
    console.log(JSON.stringify(keys, null, 2));
    return;
  }
  if (!keys.length) {
    console.log('The vault is empty. Add a secret with "facedown set NAME".');
    return;
  }
  const width = Math.max(...keys.map((k) => k.name.length));
  for (const k of keys) {
    const allow = k.allow.length ? `  [allowed: ${k.allow.join(', ')}]` : '';
    console.log(`${k.name.padEnd(width)}  ${k.description || '-'}${allow}`);
  }
}

async function cmdRun(args) {
  const split = args.indexOf('--');
  if (split === -1 || split === args.length - 1) {
    throw new Error('usage: facedown run [--keys A,B] -- command [args...]');
  }
  const options = args.slice(0, split);
  const argv = args.slice(split + 1);
  const keysText = takeOption(options, '--keys');
  const allKeys = takeFlag(options, '--all-keys');
  const strict = takeFlag(options, '--strict') || process.env.FACEDOWN_STRICT === '1';
  const quiet = takeFlag(options, '--quiet');
  const useProxy = takeFlag(options, '--proxy');
  if (options.length) throw new Error(`unknown option ${options[0]}`);
  if (keysText !== undefined && allKeys) throw new Error('use either --keys or --all-keys, not both');

  const vault = Vault.open();
  const names = keysText !== undefined ? keysText.split(',').map((k) => k.trim()).filter(Boolean) : undefined;
  if (keysText !== undefined && !names.length) throw new Error('--keys needs at least one key name');
  // Without a terminal (usually an AI running the command), the program must
  // only get the keys it needs: no silent "every secret".
  if (!names && !allKeys && vault.entries.size && !canPromptInTerminal()) {
    throw new Error(
      'say which keys the program needs, like --keys A,B ' +
        `(keys in this vault: ${[...vault.entries.keys()].join(', ')}). ` +
        'To give it every key on purpose, use --all-keys.'
    );
  }
  // A key expanded onto a command line is visible to other programs (#19).
  // With --proxy the command line only ever holds a placeholder.
  if (!useProxy) {
    const hits = findKeyExpansions(argv.join(' '), names ?? [...vault.entries.keys()]);
    if (hits.length) throw new Error(keyOnCommandLineMessage(hits));
  }
  const secrets = vault.reveal(names);
  let proxy = null;
  if (useProxy) {
    const allow = Object.fromEntries(Object.keys(secrets).map((n) => [n, vault.trustedAllow(n)]));
    if (!Object.values(allow).some((hosts) => hosts.length)) {
      console.error('facedown: none of these keys may be sent to any site, so with --proxy the program only gets placeholders.');
    }
    proxy = await startSecretProxy({ secrets, allow });
  }
  let result;
  try {
    result = await runStreaming(argv, secrets, { env: proxy?.env });
  } finally {
    await proxy?.close();
  }
  const { code, leaks } = result;
  process.exitCode = code;
  if (proxy && !quiet) {
    const sent = describeUse(proxy.used);
    console.error(sent ? `facedown: --proxy sent ${sent}.` : 'facedown: --proxy did not send any key.');
  }
  const message = leakMessage(leaks);
  if (message && strict) {
    console.error(
      `facedown: ERROR: the command printed the value of ${describeHits(leaks)}. ` +
        `It was hidden, but --strict fails the run (exit code ${LEAK_EXIT_CODE}).`
    );
    process.exitCode = LEAK_EXIT_CODE;
  } else if (message && !quiet) {
    console.error(message);
  }
}

function namesForWindow(names) {
  return names.length <= 6 ? names.join(', ') : `${names.slice(0, 6).join(', ')} and ${names.length - 6} more`;
}

async function cmdExport(args) {
  const [file, extra] = args;
  if (!file || extra !== undefined) throw new Error('usage: facedown export FILE');
  const target = path.resolve(file);
  if (fs.existsSync(target)) {
    throw new Error(`${target} already exists. Choose a new file name (an export never overwrites a file).`);
  }
  const vault = Vault.open();
  const names = [...vault.entries.keys()];
  if (!names.length) throw new Error('the vault is empty, there is nothing to export');
  vault.reveal(); // fail now, before asking anything, if a value does not decrypt

  if (canPromptInWindow()) console.error('A passphrase window opened on your screen.');
  const passphrase = await askPassphrase({
    title: 'Choose a passphrase for the export',
    again: 'Type the same passphrase again',
    okText: 'Export',
    details:
      `This copies all ${names.length} secrets (${namesForWindow(names)}) into ${path.basename(target)}. ` +
      `Anyone with that file and this passphrase can read them. At least ${MIN_PASSPHRASE_LENGTH} characters. ` +
      'If you did not ask for an export, click Cancel.',
  });
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters; nothing was written`);
  }
  const text = encryptExport(vault.exportEntries(), passphrase);
  fs.writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
  console.log(`Exported ${names.length} secret${names.length === 1 ? '' : 's'} to ${target}`);
  console.log('Keep this file safe: with the passphrase it opens every secret in it.');
  console.log(`On the other computer: facedown import ${path.basename(target)}`);
}

async function cmdImport(args) {
  const keep = takeFlag(args, '--keep');
  const [file, extra] = args;
  if (!file || extra !== undefined) throw new Error('usage: facedown import FILE   (an export file, or a .env file)');
  const source = path.resolve(file);
  let text;
  try {
    text = fs.readFileSync(source, 'utf8');
  } catch {
    throw new Error(`cannot read ${source}`);
  }
  let format;
  try {
    format = JSON.parse(text)?.format;
  } catch {
    // not JSON: maybe a .env file
  }
  if (format !== EXPORT_FORMAT) return importDotenv(source, text, { keep });

  if (canPromptInWindow()) console.error('A passphrase window opened on your screen.');
  const passphrase = await askPassphrase({
    title: `Passphrase for ${path.basename(source)}`,
    okText: 'Import',
    details: 'The passphrase chosen when this export was made. The secrets are added to the vault in this folder.',
  });
  const entries = decryptExport(text, passphrase);
  for (const e of entries) Vault.check(e?.name, e?.allow ?? []);

  const existed = Boolean(Vault.find());
  const vault = Vault.openOrInit();
  if (!existed) console.error(`Created ${vault.file}`);
  vault.importEntries(entries);
  console.log(`Imported ${entries.length} secret${entries.length === 1 ? '' : 's'} into ${vault.file}:`);
  for (const e of entries) {
    const hosts = e.allow?.length ? `  [allowed: ${e.allow.join(', ')}]` : '';
    console.log(`  ${e.name}${hosts}`);
  }
}

/**
 * `facedown import .env`: move the keys of a plain .env file into the vault.
 * Values are never printed. Afterwards it offers (in a window, or y/N in a
 * terminal) to delete the plain-text file; without anyone to ask, it keeps it.
 */
async function importDotenv(source, text, { keep }) {
  const { entries, skipped } = parseDotenv(text);
  if (!entries.length) {
    throw new Error(`${source} is neither a facedown export nor a .env file with any KEY=value lines`);
  }
  const existed = Boolean(Vault.find());
  const vault = Vault.openOrInit();
  if (!existed) console.error(`Created ${vault.file}`);
  const { added, kept } = vault.addPlain(entries);

  if (added.length) console.log(`Moved ${added.length} key${added.length === 1 ? '' : 's'} into ${vault.file}: ${added.join(', ')}`);
  if (kept.length) console.log(`Already in the vault, kept the vault's value: ${kept.join(', ')}`);
  for (const s of skipped) console.log(`Skipped ${s.name}: ${s.why}`);
  const short = entries.filter((e) => added.includes(e.name) && e.value.length < MIN_VALUE_LENGTH).map((e) => e.name);
  if (short.length) {
    console.error(`Note: ${short.join(', ')} ${short.length === 1 ? 'is' : 'are'} shorter than ${MIN_VALUE_LENGTH} characters, so hiding them in output can give them away.`);
  }
  if (added.length) {
    console.log('New keys may not be sent to any site yet. Allow one with: facedown allow NAME api.example.com');
  }

  // The plain-text file still holds every value.
  const name = path.basename(source);
  if (keep || !added.length) {
    if (added.length) console.log(`Kept ${name}. It still has the values in plain text: delete it once everything works.`);
    return;
  }
  let remove = false;
  try {
    if (canPromptInWindow()) console.error('A confirmation window opened on your screen.');
    remove = await confirmAction({
      title: `Delete ${name}?`,
      details:
        `Its ${added.length} key${added.length === 1 ? ' is' : 's are'} now encrypted in ${path.basename(vault.file)}. ` +
        `${name} still holds the values in plain text, readable by any AI or program in this folder. ` +
        'Click Cancel to keep it for now.',
      okText: 'Delete',
    });
  } catch (err) {
    if (!(err instanceof PromptCancelled)) throw err;
  }
  if (remove) {
    fs.rmSync(source);
    console.log(`Deleted ${name}. Your program can read the keys with: facedown run --keys ${added.slice(0, 2).join(',')}${added.length > 2 ? ',...' : ''} -- <command>`);
  } else {
    console.log(`Kept ${name}. It still has the values in plain text: delete it once everything works.`);
  }
}

/** A vault from before the rename keeps working; say once how to rename it. */
function legacyHint() {
  if (process.env.FACEDOWN_FILE) return;
  const file = Vault.find();
  if (file && path.basename(file) === LEGACY_FILE_NAME) {
    console.error(`facedown: this vault still has its old name (${LEGACY_FILE_NAME}). Run "facedown migrate" to rename it to ${FILE_NAME}.`);
  }
}

function cmdMigrate() {
  if (process.env.FACEDOWN_FILE) {
    throw new Error(`FACEDOWN_FILE points at ${process.env.FACEDOWN_FILE}; rename that file yourself`);
  }
  const found = Vault.find();
  if (!found) throw new Error(`no vault here. Create one with "facedown init".`);
  // find() prefers the new name, so look for the old one next to it too.
  const file = path.join(path.dirname(found), LEGACY_FILE_NAME);
  if (!fs.existsSync(file)) {
    console.log(`Nothing to do: ${found} already has the new name.`);
    return;
  }
  const target = path.join(path.dirname(file), FILE_NAME);
  withLock(file, () => {
    if (fs.existsSync(target)) {
      throw new Error(`both ${LEGACY_FILE_NAME} and ${FILE_NAME} exist in ${path.dirname(file)}. Keep the one you use and delete the other.`);
    }
    Vault.load(file); // only rename something that really is a vault
    fs.renameSync(file, target);
  });
  console.log(`Renamed ${file} to ${FILE_NAME}. Nothing else changes: same secrets, same key.`);
}

const VAULT_COMMANDS = ['set', 'list', 'ls', 'rm', 'remove', 'allow', 'check', 'run', 'export', 'import'];
/** Commands that hand secrets to something: these stop under FACEDOWN_BLOCK_INSECURE=1. */
const SECRET_COMMANDS = ['run', 'export'];

let pendingUpdate = null;

async function startUpdateCheck(command) {
  if (!VAULT_COMMANDS.includes(command) || !updateCheckEnabled()) return;
  if (blockInsecure() && SECRET_COMMANDS.includes(command)) {
    // The answer is needed before anything runs.
    const info = await checkForUpdate({ timeoutMs: 5000 });
    if (info?.security) throw new Error(insecureBlockMessage(info));
    if (!info) console.error('facedown: could not check for security updates (offline?); continuing.');
    pendingUpdate = Promise.resolve(info);
    return;
  }
  pendingUpdate = checkForUpdate(); // in parallel with the command
}

async function showUpdateNotice() {
  if (!pendingUpdate) return;
  const notice = updateNotice(await pendingUpdate);
  if (notice) console.error(notice);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (VAULT_COMMANDS.includes(command)) legacyHint();
  await startUpdateCheck(command);
  switch (command) {
    case 'init': {
      const vault = Vault.init();
      console.log(`Created ${vault.file}`);
      console.log('Add a secret with: facedown set NAME');
      break;
    }
    case 'set':
      await cmdSet(args);
      break;
    case 'list':
    case 'ls':
      cmdList(args);
      break;
    case 'rm':
    case 'remove': {
      const name = args[0];
      if (!name) throw new Error('usage: facedown rm NAME');
      const vault = Vault.open();
      if (!vault.has(name)) throw new Error(`no key named ${name}`);
      // Deleting cannot be undone, so it always needs the user's OK.
      if (canPromptInWindow()) console.error('A confirmation window opened on your screen.');
      const ok = await confirmDelete(name, { description: vault.entries.get(name).description });
      if (!ok) throw new PromptCancelled(`${name} was not deleted`);
      Vault.open().remove(name);
      console.log(`Removed ${name}.`);
      break;
    }
    case 'allow': {
      const clear = takeFlag(args, '--clear');
      const [name, ...hosts] = args;
      if (!name || (!clear && !hosts.length)) throw new Error('usage: facedown allow NAME host [host...]');
      const vault = Vault.open();
      if (!vault.has(name)) throw new Error(`no key named ${name}`);
      const wanted = clear ? [] : hosts.flatMap((h) => h.split(','));
      const adding = vault.newHosts(name, wanted);
      if (adding.length) {
        // Adding a site always needs the user's OK, even when an AI runs this.
        if (canPromptInWindow()) console.error('A confirmation window opened on your screen.');
        const ok = await confirmNewHosts(name, adding, { description: vault.entries.get(name).description });
        if (!ok) throw new PromptCancelled(`${adding.join(', ')} not allowed, nothing changed`);
      }
      vault.setAllow(name, wanted);
      const now = vault.trustedAllow(name);
      console.log(now.length ? `${name} may be sent to: ${now.join(', ')}` : `${name} may not be sent to any host.`);
      break;
    }
    case 'check': {
      const vault = Vault.open();
      const names = args.length ? args : [...vault.entries.keys()];
      if (!names.length) console.log('The vault is empty.');
      const width = Math.max(0, ...names.map((n) => n.length));
      for (const name of names) {
        try {
          const info = vault.inspect(name);
          const short = info.length < MIN_VALUE_LENGTH ? '  (short: cannot be hidden safely)' : '';
          console.log(`${name.padEnd(width)}  ok      length ${info.length}  fingerprint ${info.fingerprint}${short}`);
        } catch (err) {
          console.log(`${name.padEnd(width)}  FAILED  ${err.message}`);
          process.exitCode = 1;
        }
      }
      break;
    }
    case 'run':
      await cmdRun(args);
      break;
    case 'export':
      await cmdExport(args);
      break;
    case 'import':
      await cmdImport(args);
      break;
    case 'migrate':
      cmdMigrate();
      break;
    case 'doctor': {
      const result = await runDoctor();
      console.log(formatDoctor(result));
      if (result.failed) process.exitCode = 1;
      break;
    }
    case 'mcp':
      await serveMcp();
      break;
    case '--version':
    case '-v':
      console.log(VERSION);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      throw new Error(`unknown command "${command}". Try "facedown help".`);
  }
}

main()
  .catch((err) => {
    if (err instanceof PromptCancelled) console.error(`Cancelled: ${err.message}.`);
    else console.error(`facedown: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(showUpdateNotice);
