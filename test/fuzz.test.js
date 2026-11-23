// Random stress test for the output cleaner (src/redact.js): many random
// secrets, printed in every supported encoding, cut into random chunks with
// random pauses, mixed with random text. No secret may come out.
//
// Fixed seed, so a failure always reproduces. For a longer run:
//   FUZZ_RUNS=20000 node --test test/fuzz.test.js
// For another seed: FUZZ_SEED=123 ...

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRedactor, createStreamRedactor } from '../src/redact.js';

const RUNS = Number(process.env.FUZZ_RUNS) || 400;
const SEED = Number(process.env.FUZZ_SEED) || 20261123;

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (list) => list[int(0, list.length - 1)];
  return { next, int, pick };
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SYMBOLS = ALNUM + ' -_.~!*\'()/+=%&?#@:;,"\\$<>[]{}|^`';
const UNICODE = [...ALNUM, 'é', 'ü', 'ß', 'ñ', 'Ж', 'ש', '中', '文', '€', '😀', '🔑'];

/** How a program might print a value. Each must be hidden. */
const ENCODINGS = {
  plain: (v) => v,
  json: (v) => JSON.stringify(v).slice(1, -1),
  base64: (v) => Buffer.from(v).toString('base64'),
  base64NoPad: (v) => Buffer.from(v).toString('base64').replace(/=+$/, ''),
  base64url: (v) => Buffer.from(v).toString('base64url'),
  hex: (v) => Buffer.from(v).toString('hex'),
  hexUpper: (v) => Buffer.from(v).toString('hex').toUpperCase(),
  uriComponent: (v) => encodeURIComponent(v),
  uriComponentLower: (v) => encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()),
  form: (v) => new URLSearchParams({ v }).toString().slice(2),
  quotePlus: (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+'),
  uri: (v) => encodeURI(v),
};

function randomString(r, alphabet, lo, hi) {
  const chars = typeof alphabet === 'string' ? [...alphabet] : alphabet;
  return Array.from({ length: r.int(lo, hi) }, () => r.pick(chars)).join('');
}

/** A random case: secrets (some overlapping) and the output a program prints. */
function makeCase(r) {
  const secrets = {};
  const count = r.int(1, 3);
  for (let i = 0; i < count; i++) {
    const kind = r.next();
    let value;
    const existing = Object.values(secrets);
    if (existing.length && kind < 0.15) {
      // Overlaps another secret: a piece of it...
      const other = [...r.pick(existing)]; // by character, never half an emoji
      const start = r.int(0, Math.max(0, other.length - 8));
      value = other.slice(start, start + r.int(8, other.length - start)).join('');
    } else if (existing.length && kind < 0.3) {
      // ...or something that ends with its first characters.
      const other = [...r.pick(existing)];
      value = randomString(r, ALNUM, 2, 10) + other.slice(0, r.int(4, Math.min(12, other.length))).join('');
    } else if (kind < 0.55) {
      value = randomString(r, ALNUM, 8, 48);
    } else if (kind < 0.85) {
      value = randomString(r, SYMBOLS, 8, 40);
    } else {
      value = randomString(r, UNICODE, 8, 24);
    }
    if ([...value].length < 8 || existing.includes(value)) continue;
    secrets[`KEY_${i}`] = value;
  }

  const parts = [];
  const printed = []; // { name, text }: what was printed for which key
  const pieces = r.int(1, 8);
  for (let i = 0; i < pieces; i++) {
    parts.push(randomString(r, r.next() < 0.8 ? ALNUM + ' \n:=' : SYMBOLS, 0, 20));
    const names = Object.keys(secrets);
    const name = r.pick(names);
    const roll = r.next();
    const crossing = names.flatMap((b) =>
      names.filter((a) => a !== b).flatMap((a) => {
        // b ends with the first characters of a: print b's start, then a, so
        // b's match runs into a.
        for (let k = Math.min(secrets[b].length, secrets[a].length) - 1; k >= 4; k--) {
          if (secrets[b].endsWith(secrets[a].slice(0, k))) return [{ a, lead: secrets[b].slice(0, -k) }];
        }
        return [];
      })
    );
    if (crossing.length && roll < 0.3) {
      const { a, lead } = r.pick(crossing);
      parts.push(lead + secrets[a]);
      printed.push({ name: a, text: secrets[a] });
    } else if (roll < 0.4) {
      // Two overlapping secrets written back to back, or one inside the other.
      const other = r.pick(names);
      const text = secrets[name] + secrets[other];
      parts.push(text);
      printed.push({ name, text: secrets[name] }, { name: other, text: secrets[other] });
    } else if (roll < 0.45) {
      parts.push(name); // the key name itself, which stays readable
    } else {
      const encoding = r.pick(Object.keys(ENCODINGS));
      const text = ENCODINGS[encoding](secrets[name]);
      parts.push(text);
      printed.push({ name, text });
    }
  }
  return { secrets, output: parts.join(''), printed };
}

/** Every way a secret could be visible in the output. */
function leaksIn(out, secrets) {
  // Key names are shown on purpose (even when a value is part of one): take
  // them out before looking.
  let rest = out;
  for (const name of Object.keys(secrets).sort((a, b) => b.length - a.length)) rest = rest.split(name).join(' ');
  const found = [];
  for (const [name, value] of Object.entries(secrets)) {
    for (const [encoding, fn] of Object.entries(ENCODINGS)) {
      const text = fn(value);
      if (text.length >= 8 && rest.includes(text)) found.push(`${name} as ${encoding}`);
    }
    // A large piece of the value counts too: a secret cut in half is a leak.
    const chars = [...value];
    const keep = Math.ceil(chars.length * 0.6);
    for (let i = 0; i + keep <= chars.length; i++) {
      if (rest.includes(chars.slice(i, i + keep).join(''))) {
        found.push(`${name}: ${keep} of ${chars.length} characters`);
        break;
      }
    }
  }
  return found;
}

function chunks(r, text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const n = r.int(1, 12);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

function report(c, out, leaks, seed, run) {
  return (
    `leak found (seed ${seed}, run ${run}): ${leaks.join('; ')}\n` +
    `secrets: ${JSON.stringify(c.secrets)}\noutput:  ${JSON.stringify(c.output)}\ncleaned: ${JSON.stringify(out)}`
  );
}

test(`fuzz: ${RUNS} random cases, cut into chunks with pauses, never leak`, () => {
  const r = rng(SEED);
  for (let run = 0; run < RUNS; run++) {
    const c = makeCase(r);
    if (!Object.keys(c.secrets).length) continue;
    const red = createRedactor(c.secrets);
    let out = '';
    for (const piece of chunks(r, c.output)) {
      out += red.push(piece);
      if (r.next() < 0.3) out += red.flushIdle(); // the program paused here
    }
    out += red.flush();
    const leaks = leaksIn(out, c.secrets);
    assert.deepEqual(leaks, [], report(c, out, leaks, SEED, run));
    // Everything printed was hidden, so the hit count covers it.
    if (c.printed.length) assert.ok(Object.keys(red.hits()).length, report(c, out, ['no hits counted'], SEED, run));
  }
});

test('fuzz: whole strings at once give the same result as chunks', () => {
  const r = rng(SEED + 1);
  for (let run = 0; run < Math.min(RUNS, 300); run++) {
    const c = makeCase(r);
    if (!Object.keys(c.secrets).length) continue;
    const whole = createRedactor(c.secrets).all(c.output);
    const red = createRedactor(c.secrets);
    let out = '';
    for (const piece of chunks(r, c.output)) out += red.push(piece);
    out += red.flush();
    assert.equal(out, whole, report(c, out, ['chunked output differs'], SEED + 1, run));
  }
});

test('fuzz: byte streams, multi-byte characters split across chunks, real pauses', async () => {
  const r = rng(SEED + 2);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let run = 0; run < Math.min(RUNS, 40); run++) {
    const c = makeCase(r);
    if (!Object.keys(c.secrets).length) continue;
    let out = '';
    const stream = createStreamRedactor(c.secrets, (t) => (out += t), 2);
    const bytes = Buffer.from(c.output, 'utf8');
    let i = 0;
    while (i < bytes.length) {
      const n = r.int(1, 9);
      stream.write(bytes.subarray(i, i + n)); // may cut a character in half
      i += n;
      if (r.next() < 0.15) await wait(5); // longer than the idle time
    }
    stream.end();
    const leaks = leaksIn(out, c.secrets);
    assert.deepEqual(leaks, [], report(c, out, leaks, SEED + 2, run));
    assert.ok(!out.includes('�'), 'no broken characters');
  }
});
