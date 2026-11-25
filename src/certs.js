// A tiny certificate authority for the --proxy mode, with no dependencies.
//
// Node can make keys and signatures but not certificates, so this builds
// X.509 v3 certificates (DER) by hand. Each `facedown run --proxy` makes a new
// authority that lives only in memory: its private key is never written
// anywhere, and everything it signed stops mattering when the run ends.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import net from 'node:net';

// --- DER encoding ----------------------------------------------------------

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const integer = (bytes) => tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octets = (bytes) => tlv(0x04, bytes);
const bits = (bytes, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const explicit = (n, content) => tlv(0xa0 | n, content);

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const value of parts.slice(2)) {
    const chunk = [value & 0x7f];
    for (let x = value >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime (valid until 2049, which is plenty for one-day certificates). */
function utcTime(date) {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

const commonName = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ECDSA_WITH_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function extension(id, value, critical = false) {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

function altNames(hosts) {
  return seq(
    ...hosts.map((h) => {
      const ip = net.isIP(h);
      if (ip === 4) return tlv(0x87, Buffer.from(h.split('.').map(Number)));
      if (ip === 6) return tlv(0x87, ipv6Bytes(h));
      return tlv(0x82, Buffer.from(h, 'ascii'));
    })
  );
}

function ipv6Bytes(address) {
  const [head, tail = ''] = address.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return Buffer.from(groups.flatMap((g) => [(parseInt(g, 16) >> 8) & 0xff, parseInt(g, 16) & 0xff]));
}

function newKey() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function keyId(publicKey) {
  return createHash('sha1').update(publicKey.export({ type: 'spki', format: 'der' })).digest();
}

function serialNumber() {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f; // positive
  return bytes;
}

function toPem(der, label = 'CERTIFICATE') {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function buildCertificate({ subject, issuer, publicKey, signingKey, extensions, days = 1 }) {
  const now = Date.now();
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serialNumber()),
    ECDSA_WITH_SHA256,
    commonName(issuer),
    seq(utcTime(new Date(now - 60 * 60 * 1000)), utcTime(new Date(now + days * 24 * 60 * 60 * 1000))),
    commonName(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions))
  );
  const signature = sign('sha256', tbs, signingKey); // ECDSA, DER-encoded
  return toPem(seq(tbs, ECDSA_WITH_SHA256, bits(signature)));
}

// --- the authority ------------------------------------------------------------

/**
 * A new certificate authority, in memory only.
 * Returns { certPem, issue(host) -> { cert, key } } where cert/key are PEM.
 */
export function createAuthority(name = 'facedown proxy (temporary, this run only)') {
  const ca = newKey();
  const caId = keyId(ca.publicKey);
  const certPem = buildCertificate({
    subject: name,
    issuer: name,
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
    extensions: [
      extension('2.5.29.19', seq(bool(true), integer(Buffer.from([0]))), true), // CA, no sub-CAs
      extension('2.5.29.15', bits(Buffer.from([0x06]), 1), true), // keyCertSign, cRLSign
      extension('2.5.29.14', octets(caId)),
    ],
  });

  // One key for every host certificate of this run; certificates are cached.
  const leaf = newKey();
  const leafKeyPem = leaf.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const leafId = keyId(leaf.publicKey);
  const issued = new Map();

  function issue(host) {
    const h = String(host).toLowerCase();
    if (!issued.has(h)) {
      issued.set(
        h,
        buildCertificate({
          subject: h,
          issuer: name,
          publicKey: leaf.publicKey,
          signingKey: ca.privateKey,
          extensions: [
            extension('2.5.29.19', seq(), true), // not a CA
            extension('2.5.29.15', bits(Buffer.from([0x80]), 7), true), // digitalSignature
            extension('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))), // serverAuth
            extension('2.5.29.17', altNames([h])),
            extension('2.5.29.14', octets(leafId)),
            extension('2.5.29.35', seq(tlv(0x80, caId))),
          ],
        })
      );
    }
    return { cert: issued.get(h), key: leafKeyPem };
  }

  return { certPem, issue };
}
