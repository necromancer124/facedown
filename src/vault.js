import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLegacy, newMasterKey, newVaultId, open, seal } from './crypto.js';
import {
  FILE_NAME,
  LEGACY_FILE_NAME,
  NAME_RE,
  cleanDescription,
  normalizeHosts,
  parseVault,
  ruleActive,
  serializeVault,
  splitRule,
} from './format.js';
import { loadKey, saveKey } from './keystore.js';

/**
 * Shorter values are refused unless the user allows it. Hiding a short value
 * in output gives it away: "test" masked inside "testing" shows what it is.
 */
export const MIN_VALUE_LENGTH = 8;

// Saving is read-modify-write. The MCP server and the CLI can both save at the
// same moment (add_key waiting on its window while "facedown set" runs in a
// terminal), so every change takes a lock file next to the vault, re-reads the
// vault from disk, applies only its own change, and writes it back.
const LOCK_WAIT_MS = 10_000;
/** A lock older than this is from a crashed process (a save takes milliseconds). */
const STALE_LOCK_MS = 30_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Remove a lock left behind by a crashed process. True if it was removed. */
function clearStaleLock(lock) {
  let stat, owner;
  try {
    stat = fs.statSync(lock);
    owner = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10);
  } catch {
    return false; // gone already, or being written right now
  }
  const age = Date.now() - stat.mtimeMs;
  const dead = Number.isInteger(owner) && owner > 0 && owner !== process.pid && !processAlive(owner);
  if (!dead && age < STALE_LOCK_MS) return false;
  // Move it aside first, so two processes cleaning up at once cannot both
  // delete: only one rename succeeds.
  const aside = `${lock}.stale-${process.pid}`;
  try {
    fs.renameSync(lock, aside);
    fs.unlinkSync(aside);
    return true;
  } catch {
    return false;
  }
}

export function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (err) {
      // EPERM: on Windows a lock that is being deleted cannot be opened yet.
      if (err.code !== 'EEXIST' && err.code !== 'EPERM') throw err;
      if (clearStaleLock(lock)) continue;
      if (Date.now() > deadline) {
        throw new Error(
          `the vault is busy: another facedown is saving it (${lock}). ` +
            'Try again. If no other facedown is running, delete that file.'
        );
      }
      sleepSync(10 + Math.random() * 30);
      continue;
    }
    try {
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return fn();
    } finally {
      try {
        fs.unlinkSync(lock);
      } catch {
        // already gone
      }
    }
  }
}

/** Windows refuses to replace a file another process has open for a moment. */
function replaceFile(tmp, file) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || attempt >= 50) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // nothing to clean up
        }
        throw err;
      }
      sleepSync(20);
    }
  }
}

export class Vault {
  constructor(file, data) {
    this.file = file;
    this.id = data.id;
    this.entries = data.entries;
    this._key = null;
  }

  /**
   * Look for a .env.facedown file in startDir, then in each parent folder.
   * A vault from before the rename (.aienv) is found too.
   */
  static find(startDir = process.cwd()) {
    if (process.env.FACEDOWN_FILE) {
      return fs.existsSync(process.env.FACEDOWN_FILE) ? process.env.FACEDOWN_FILE : null;
    }
    let dir = path.resolve(startDir);
    for (;;) {
      for (const name of [FILE_NAME, LEGACY_FILE_NAME]) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  static load(file) {
    return new Vault(file, parseVault(fs.readFileSync(file, 'utf8')));
  }

  static open(startDir) {
    const file = Vault.find(startDir);
    if (!file) throw new Error(`no ${FILE_NAME} vault here. Create one with "facedown init".`);
    return Vault.load(file);
  }

  static init(dir = process.cwd()) {
    const file = process.env.FACEDOWN_FILE || path.join(path.resolve(dir), FILE_NAME);
    if (fs.existsSync(file)) throw new Error(`${file} already exists`);
    const vault = new Vault(file, { id: newVaultId(), entries: new Map() });
    vault._key = newMasterKey();
    withLock(file, () => {
      // Someone else may have created it while we were starting.
      if (fs.existsSync(file)) throw Object.assign(new Error(`${file} already exists`), { code: 'VAULT_EXISTS' });
      saveKey(vault.id, vault._key);
      vault.save();
    });
    return vault;
  }

  static openOrInit(startDir = process.cwd()) {
    const file = Vault.find(startDir);
    if (file) return Vault.load(file);
    try {
      return Vault.init(startDir);
    } catch (err) {
      // Created by another facedown at the same moment: use that one.
      const now = Vault.find(startDir);
      if (err.code === 'VAULT_EXISTS' && now) return Vault.load(now);
      throw err;
    }
  }

  key() {
    if (!this._key) this._key = loadKey(this.id);
    return this._key;
  }

  /** Write the vault as it is in memory. Callers hold the lock. */
  save() {
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, serializeVault(this));
    replaceFile(tmp, this.file);
  }

  /**
   * Apply one change safely: take the lock, reload the entries from disk (so
   * changes saved by another process meanwhile are kept), apply, write.
   */
  _update(change) {
    this.key(); // unlock first: on Windows that can take a second
    return withLock(this.file, () => {
      if (fs.existsSync(this.file)) {
        const disk = parseVault(fs.readFileSync(this.file, 'utf8'));
        if (disk.id !== this.id) throw new Error(`${this.file} was replaced by a different vault; nothing saved`);
        this.entries = disk.entries;
      }
      const result = change();
      this.save();
      return result;
    });
  }

  has(name) {
    return this.entries.has(name);
  }

  /**
   * Names, descriptions, allowed hosts and when each value was last set.
   * Never values. `temporary` maps a host allowed for a limited time to the
   * moment it stops (ISO); `set` is when the value was last set, or null if
   * unknown (keys saved before facedown recorded it).
   */
  list() {
    return [...this.entries.values()].map(({ name, description, setAt }) => {
      const rules = this.trustedAllow(name);
      const temporary = {};
      for (const r of rules) {
        const { host, until } = splitRule(r);
        if (until !== null) temporary[host] = new Date(until * 1000).toISOString();
      }
      return {
        name,
        description,
        allow: rules.map((r) => splitRule(r).host),
        temporary,
        set: setAt ?? null,
      };
    });
  }

  /** Throws if the name or hosts are not valid. Saves nothing. */
  static check(name, allow) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(`invalid key name "${name}" (use letters, digits and _, like GITHUB_TOKEN)`);
    }
    if (allow !== undefined) {
      if (!Array.isArray(allow)) throw new Error('allow must be a list of hosts');
      normalizeHosts(allow);
    }
  }

  set(name, value, { description, allow, allowShort = false } = {}) {
    Vault.check(name, allow);
    if (typeof value !== 'string' || value.length === 0) throw new Error('the value is empty');
    if (value.length < MIN_VALUE_LENGTH && !allowShort) {
      const err = new Error(
        `${name} is only ${value.length} characters. Values shorter than ${MIN_VALUE_LENGTH} cannot be hidden ` +
          'safely in output (the hiding itself gives them away). Use a longer value, or if it really is short ' +
          `(like a PIN), run "facedown set ${name} --allow-short" in a terminal.`
      );
      err.code = 'SHORT_VALUE';
      throw err;
    }
    this._update(() => {
      const old = this.entries.get(name);
      // A legacy (v1) entry's hosts were never protected, so they are not carried over.
      const keptAllow = old && !isLegacy(old.sealed) ? old.allow : [];
      const finalAllow = allow !== undefined ? normalizeHosts(allow) : keptAllow;
      this.entries.set(name, {
        name,
        sealed: seal(this.key(), this.id, name, value, finalAllow),
        description: description !== undefined ? cleanDescription(description) : old?.description ?? '',
        allow: finalAllow,
        setAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      });
    });
  }

  remove(name) {
    this._update(() => {
      if (!this.entries.delete(name)) throw new Error(`no key named ${name}`);
    });
  }

  /**
   * Replace a key's allowed hosts. The value is sealed again, because the
   * hosts are part of what the encryption protects.
   * Callers must get the user's confirmation before ADDING a host.
   */
  setAllow(name, hosts) {
    const allow = normalizeHosts(hosts).filter((r) => ruleActive(r)); // expired rules are dropped
    this._update(() => {
      const entry = this.entries.get(name);
      if (!entry) throw new Error(`no key named ${name}`);
      const value = this.reveal([name])[name];
      entry.allow = allow;
      entry.sealed = seal(this.key(), this.id, name, value, entry.allow);
    });
  }

  /**
   * The hosts a key may really be sent to. Legacy (v1) entries count as none:
   * their host list was not protected and could have been edited by hand.
   * (For v2 entries a hand-edited list makes decryption fail instead.)
   */
  trustedAllow(name) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`no key named ${name}`);
    // Rules whose time is up count as gone (they are dropped on the next change).
    return isLegacy(entry.sealed) ? [] : entry.allow.filter((r) => ruleActive(r));
  }

  /**
   * Rules in `hosts` that would let this key go somewhere new: a host it may
   * not reach now, or a longer time than it already has there.
   */
  newHosts(name, hosts) {
    const permanent = new Set();
    const timed = new Map();
    for (const r of this.trustedAllow(name)) {
      const { host, until } = splitRule(r);
      if (until === null) permanent.add(host);
      else timed.set(host, Math.max(timed.get(host) ?? 0, until));
    }
    return normalizeHosts(hosts).filter((r) => {
      const { host, until } = splitRule(r);
      if (permanent.has(host)) return false;
      if (until === null) return true;
      return !(timed.get(host) >= until);
    });
  }

  /**
   * The full rule list after allowing `hosts` for `minutes` (temporary access).
   * Hosts the key may already reach for good stay as they are.
   */
  withTemporary(name, hosts, minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('the time must be a positive number of minutes');
    const until = Math.floor(Date.now() / 1000) + Math.round(minutes * 60);
    const wanted = normalizeHosts(hosts).map((h) => splitRule(h).host);
    const current = this.trustedAllow(name);
    const permanent = new Set(current.filter((r) => splitRule(r).until === null));
    const kept = current.filter((r) => {
      const { host, until: u } = splitRule(r);
      return u === null || !wanted.includes(host);
    });
    return [...kept, ...wanted.filter((h) => !permanent.has(h)).map((h) => `${h}@${until}`)];
  }

  /**
   * Facts about a value that are safe to show: its length and a fingerprint.
   * The fingerprint is keyed with the vault key, so it cannot be used to guess
   * the value. It includes the key name, so it only tells "same value as
   * before" for one key: a test key holding a guess can never match another
   * key's fingerprint (that would let a program guess values offline).
   */
  inspect(name) {
    const value = this.reveal([name])[name];
    const mac = createHmac('sha256', this.key())
      .update(`blind-env:fingerprint:v2:${name}:`)
      .update(value)
      .digest('hex');
    return { length: value.length, fingerprint: mac.slice(0, 8) };
  }

  /**
   * Every entry with its value, for an export. Internal use only: the result
   * must go straight into encryptExport, never to anything the AI can read.
   * Throws (and returns nothing) if any value fails to decrypt.
   */
  exportEntries() {
    const values = this.reveal();
    return [...this.entries.values()].map(({ name, description, setAt }) => ({
      name,
      description,
      allow: this.trustedAllow(name),
      setAt: setAt ?? undefined,
      value: values[name],
    }));
  }

  /**
   * Add entries from an export. All or nothing: if any name already exists
   * here, or anything is invalid, nothing is written.
   */
  importEntries(entries) {
    for (const e of entries) {
      Vault.check(e?.name, e?.allow ?? []);
      if (typeof e.value !== 'string' || !e.value) throw new Error(`the export has no value for ${e.name}`);
    }
    const names = entries.map((e) => e.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) throw new Error(`the export lists ${dupes[0]} twice; nothing imported`);
    this._update(() => {
      const clash = names.filter((n) => this.entries.has(n));
      if (clash.length) {
        throw new Error(
          `this vault already has ${clash.join(', ')}. Nothing was imported. ` +
            'Remove those keys first (facedown rm NAME), or import into a new folder.'
        );
      }
      for (const e of entries) {
        const allow = normalizeHosts(e.allow ?? []);
        this.entries.set(e.name, {
          name: e.name,
          sealed: seal(this.key(), this.id, e.name, e.value, allow),
          description: cleanDescription(e.description),
          allow,
          setAt: typeof e.setAt === 'string' && !Number.isNaN(Date.parse(e.setAt)) ? e.setAt : new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        });
      }
    });
  }

  /**
   * Decrypt values. Internal use only: the result must go to a child process
   * or an outgoing request, never to anything the AI can read.
   */
  reveal(names = [...this.entries.keys()]) {
    const out = {};
    for (const name of names) {
      const entry = this.entries.get(name);
      if (!entry) throw new Error(`no key named ${name}`);
      out[name] = open(this.key(), this.id, name, entry.sealed, entry.allow);
    }
    return out;
  }
}

/**
 * Is this key allowed to be sent to this host? An empty list allows nothing.
 * A rule with an end time ("host@<unix seconds>") only counts until then.
 */
export function hostAllowed(allow, hostname, nowSeconds = Math.floor(Date.now() / 1000)) {
  const host = hostname.toLowerCase();
  return allow.some((r) => {
    if (!ruleActive(r, nowSeconds)) return false;
    const rule = splitRule(r).host;
    return rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1 : host === rule;
  });
}

/** "api.github.com, example.com (until 14:30)" for people. */
export function describeAllow(rules) {
  return rules
    .map((r) => {
      const { host, until } = splitRule(r);
      if (until === null) return host;
      const end = new Date(until * 1000);
      const sameDay = end.toDateString() === new Date().toDateString();
      const when = sameDay
        ? end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : end.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `${host} (until ${when})`;
    })
    .join(', ');
}

/** "today", "3 days ago", or '' if unknown. */
export function describeAge(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}
