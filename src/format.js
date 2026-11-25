// The .env.facedown file format (called .aienv when the project was blind-env).
//
//   # facedown vault v1 id=<vault id>
//
//   # @desc GitHub token for the API
//   # @allow github.com,api.github.com
//   GITHUB_TOKEN=enc:v1:<base64url>
//
// Names, descriptions and allowed hosts are plain text (the AI may read them).
// Values are always encrypted.

export const FILE_NAME = '.env.facedown';
/** The file name from before the rename (blind-env). Still found and read. */
export const LEGACY_FILE_NAME = '.aienv';
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SEALED_RE = /^enc:v[12]:/;

// "blind-env" is the project's earlier name; vaults made by it are still read.
const HEADER_RE = /^(?:facedown|blind-env) vault v(\d+) id=([A-Za-z0-9_-]+)$/;

export function parseVault(text) {
  const vault = { id: null, entries: new Map() };
  let description = '';
  let allow = [];
  let setAt = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const where = `${FILE_NAME} line ${i + 1}`;

    if (!line) {
      description = '';
      allow = [];
      setAt = null;
      continue;
    }

    if (line.startsWith('#')) {
      const comment = line.slice(1).trim();
      let m;
      if ((m = HEADER_RE.exec(comment))) {
        if (m[1] !== '1') throw new Error(`${where}: unsupported vault version v${m[1]}`);
        vault.id = m[2];
      } else if ((m = /^@desc\s+(.*)$/.exec(comment))) {
        description = m[1].trim();
      } else if ((m = /^@allow\s+(.*)$/.exec(comment))) {
        allow = normalizeHosts(m[1].split(/[,\s]+/));
      } else if ((m = /^@set\s+(\S+)$/.exec(comment))) {
        // When the value was last set. Plain information: not encrypted, and
        // editing it by hand changes nothing about what the key may do.
        setAt = Number.isNaN(Date.parse(m[1])) ? null : m[1];
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 1) throw new Error(`${where}: expected NAME=enc:v1:...`);
    const name = line.slice(0, eq).trim();
    let sealed = line.slice(eq + 1).trim();
    if (sealed.length >= 2 && sealed.startsWith('"') && sealed.endsWith('"')) {
      sealed = sealed.slice(1, -1);
    }
    if (!NAME_RE.test(name)) throw new Error(`${where}: invalid key name "${name}"`);
    if (!SEALED_RE.test(sealed)) {
      // Never echo the value: it may be a plain-text secret pasted by mistake.
      throw new Error(
        `${where}: the value of ${name} is not encrypted. ` +
          `Delete that line and add the key with "facedown set ${name}".`
      );
    }
    vault.entries.set(name, { name, sealed, description, allow, setAt });
    description = '';
    allow = [];
    setAt = null;
  }

  if (!vault.id) throw new Error(`${FILE_NAME}: missing "# facedown vault v1 id=..." header`);
  return vault;
}

export function serializeVault(vault) {
  const out = [
    `# facedown vault v1 id=${vault.id}`,
    '# Names and notes are readable. Values are encrypted; the key is NOT in this folder.',
    '# Edit with the facedown tool, not by hand.',
    '# AI agents: use these keys by NAME ("facedown run --keys NAME -- <command>" or the facedown tools).',
    '# Never print, log, decode or copy a value, and never ask the user to paste one in chat.',
  ];
  for (const e of vault.entries.values()) {
    out.push('');
    if (e.description) out.push(`# @desc ${e.description}`);
    if (e.allow.length) out.push(`# @allow ${e.allow.join(',')}`);
    if (e.setAt) out.push(`# @set ${e.setAt}`);
    out.push(`${e.name}=${e.sealed}`);
  }
  return out.join('\n') + '\n';
}

export function normalizeHosts(hosts) {
  const seen = new Set();
  for (const h of hosts) {
    const host = String(h).trim().toLowerCase();
    if (!host) continue;
    // A rule may end in "@<unix seconds>": allowed until then (temporary access).
    // The whole rule is part of the encryption, so the time can't be extended by hand.
    if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(@\d{9,11})?$/.test(host)) {
      throw new Error(`invalid host "${h}" (use a bare host like "github.com" or "*.github.com")`);
    }
    seen.add(host);
  }
  return [...seen];
}

/** "api.github.com@1764000000" -> { host: 'api.github.com', until: 1764000000 }; until is null if permanent. */
export function splitRule(rule) {
  const at = rule.lastIndexOf('@');
  return at === -1 ? { host: rule, until: null } : { host: rule.slice(0, at), until: Number(rule.slice(at + 1)) };
}

/** Is this allowed-site rule still in force? */
export function ruleActive(rule, nowSeconds = Math.floor(Date.now() / 1000)) {
  const { until } = splitRule(rule);
  return until === null || until > nowSeconds;
}

export function cleanDescription(text) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
}
