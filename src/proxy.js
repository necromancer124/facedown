// --proxy mode: the program gets placeholders instead of keys, and a local
// HTTPS proxy swaps a placeholder for the real key only in requests to a site
// on that key's allowed list.
//
// Idea from the discussion with u/Deynekin on r/mcp: keep the real value out
// of every channel the program controls (its output, files, command lines),
// so it only ever exists inside facedown and in the request to an allowed site.
//
//   program --placeholder--> proxy (127.0.0.1) --real key--> allowed site
//
// - Requests to other sites are tunnelled untouched: they only ever carry the
//   worthless placeholder.
// - Responses from an allowed site get the real value turned back into the
//   placeholder (and its encodings hidden), so the program never sees it.
// - The proxy talks to the real site with normal certificate checks. The
//   program trusts a certificate authority that exists for this run only.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createAuthority } from './certs.js';
import { createRedactor } from './redact.js';
import { hostAllowed } from './vault.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_BODY = 20 * 1024 * 1024;

/** Replace every occurrence of `from` with `to` in a Buffer. */
function replaceAll(buf, from, to) {
  const needle = Buffer.from(from, 'utf8');
  let at = buf.indexOf(needle);
  if (at === -1) return buf;
  const parts = [];
  let start = 0;
  for (; at !== -1; at = buf.indexOf(needle, start)) {
    parts.push(buf.subarray(start, at), Buffer.from(to, 'utf8'));
    start = at + needle.length;
  }
  parts.push(buf.subarray(start));
  return Buffer.concat(parts);
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        stream.destroy();
        reject(new Error('body too large'));
      } else chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const looksTextual = (type = '') => !type || /^text\/|json|xml|javascript|x-www-form-urlencoded|graphql/i.test(type);

/**
 * Start the proxy for one run.
 *   secrets: { NAME: realValue }   allow: { NAME: [hosts] }
 * Resolves to { env, placeholders, used, close() }.
 * `env` is what to add to the program's environment.
 * `upstreamCa` is for tests (a private CA the fake "real site" uses).
 */
export async function startSecretProxy({ secrets, allow, upstreamCa } = {}) {
  const placeholders = {};
  for (const name of Object.keys(secrets)) {
    placeholders[name] = `facedown-placeholder-${name}-${randomBytes(6).toString('hex')}`;
  }
  const used = {}; // NAME -> { host: count }
  const authority = createAuthority();

  /** Keys whose real value may go to this host (over this scheme). */
  function keysFor(host, secure) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (!secure && !LOOPBACK.has(h)) return []; // never send a key over plain http to the internet
    return Object.keys(secrets).filter((name) => hostAllowed(allow[name] ?? [], h));
  }

  function swapIn(text, names, host) {
    let out = text;
    for (const name of names) {
      if (out.includes(placeholders[name])) {
        used[name] ??= {};
        used[name][host] = (used[name][host] ?? 0) + out.split(placeholders[name]).length - 1;
        out = out.split(placeholders[name]).join(secrets[name]);
      }
    }
    return out;
  }

  /** The real values must never come back to the program. */
  const redactor = () => createRedactor(secrets);
  function swapOut(text) {
    let out = text;
    for (const [name, value] of Object.entries(secrets)) out = out.split(value).join(placeholders[name]);
    return redactor().finish(out);
  }

  async function forward(req, res, { host, port, secure }) {
    try {
      const names = keysFor(host, secure);
      let body = await readBody(req);
      for (const name of names) {
        const before = body.length;
        const swapped = replaceAll(body, placeholders[name], secrets[name]);
        if (swapped !== body || swapped.length !== before) {
          used[name] ??= {};
          used[name][host] = (used[name][host] ?? 0) + 1;
        }
        body = swapped;
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const key = k.toLowerCase();
        if (['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding'].includes(key)) continue;
        headers[k] = Array.isArray(v) ? v.map((x) => swapIn(x, names, host)) : swapIn(String(v), names, host);
      }
      headers['accept-encoding'] = 'identity'; // so the response can be checked
      headers['content-length'] = String(body.length);

      const pathPart = req.url.startsWith('http') ? new URL(req.url).pathname + new URL(req.url).search : req.url;
      const upstream = (secure ? https : http).request({
        host: host.replace(/^\[|\]$/g, ''),
        port,
        method: req.method,
        path: pathPart,
        headers,
        servername: net.isIP(host) ? undefined : host,
        ca: upstreamCa ? [...tls.rootCertificates, upstreamCa] : undefined,
        timeout: 60_000,
      });
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`facedown proxy: ${swapOut(err.message)}\n`);
      });
      upstream.on('response', async (up) => {
        let data = await readBody(up);
        data = Object.values(secrets).reduce((acc, value, i) => replaceAll(acc, value, Object.values(placeholders)[i]), data);
        if (looksTextual(up.headers['content-type'])) data = Buffer.from(redactor().finish(data.toString('utf8')), 'utf8');
        const out = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (['transfer-encoding', 'connection', 'keep-alive', 'content-length'].includes(k)) continue;
          out[k] = Array.isArray(v) ? v.map(swapOut) : swapOut(String(v));
        }
        out['content-length'] = String(data.length);
        res.writeHead(up.statusCode, up.statusMessage, out);
        res.end(data);
      });
      upstream.end(body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`facedown proxy: ${swapOut(String(err.message))}\n`);
    }
  }

  // Requests that arrive inside a TLS connection we answered (allowed hosts).
  const inner = http.createServer((req, res) => forward(req, res, req.socket.facedownTarget));
  inner.on('clientError', (_err, socket) => socket.destroy());

  // The proxy itself: plain http requests and CONNECT tunnels.
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end('facedown proxy: expected an absolute URL\n');
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end('facedown proxy: use CONNECT for https\n');
      return;
    }
    forward(req, res, { host: url.hostname, port: Number(url.port) || 80, secure: false });
  });

  const sockets = new Set(); // CONNECT sockets leave the server's own tracking
  const track = (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    return s;
  };

  server.on('connect', (req, client, head) => {
    track(client);
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url);
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const [, host, portText] = m;
    const port = Number(portText);
    client.on('error', () => {});
    if (!keysFor(host, true).length) {
      // No key may go there: a plain tunnel, nothing is changed or decrypted.
      const remote = track(net.connect(port, host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) remote.write(head);
        remote.pipe(client);
        client.pipe(remote);
      }));
      remote.on('error', () => client.destroy());
      return;
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const { cert, key } = authority.issue(host);
    const secure = new tls.TLSSocket(client, { isServer: true, cert, key, ALPNProtocols: ['http/1.1'] });
    secure.facedownTarget = { host, port, secure: true };
    secure.on('error', () => secure.destroy());
    if (head?.length) client.unshift(head);
    inner.emit('connection', secure);
  });
  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${server.address().port}`;

  // Certificate files for the program: ours alone (for tools that ADD it to
  // their trust list) and ours plus the usual roots (for tools that REPLACE it).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facedown-proxy-'));
  const caFile = path.join(dir, 'facedown-ca.pem');
  const bundleFile = path.join(dir, 'ca-bundle.pem');
  fs.writeFileSync(caFile, authority.certPem);
  fs.writeFileSync(bundleFile, [authority.certPem, ...tls.rootCertificates].join('\n'));
  const curlrc = `cacert = "${bundleFile.replace(/\\/g, '/')}"\nssl-revoke-best-effort\n`;
  fs.writeFileSync(path.join(dir, '.curlrc'), curlrc);
  fs.writeFileSync(path.join(dir, '_curlrc'), curlrc);

  const env = {
    ...placeholders,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
    NODE_USE_ENV_PROXY: '1', // Node 24+ fetch and http
    NODE_EXTRA_CA_CERTS: caFile,
    SSL_CERT_FILE: bundleFile,
    REQUESTS_CA_BUNDLE: bundleFile,
    CURL_CA_BUNDLE: bundleFile,
    GIT_SSL_CAINFO: bundleFile,
    // For tools that ignore all of the above: pass it yourself.
    FACEDOWN_PROXY_CA: bundleFile,
    // curl on Windows uses the Windows certificate store and ignores
    // CURL_CA_BUNDLE, and it insists on a revocation check this one-run
    // certificate cannot answer. A curl config file for this run fixes both.
    CURL_HOME: dir,
  };

  return {
    env,
    placeholders,
    used,
    url: proxyUrl,
    caPem: authority.certPem,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections?.();
        inner.closeAllConnections?.();
        fs.rmSync(dir, { recursive: true, force: true });
        server.close(() => resolve());
      }),
  };
}

/** "GITHUB_TOKEN to api.github.com (2x)", or '' if nothing was sent. */
export function describeUse(used) {
  const parts = [];
  for (const [name, hosts] of Object.entries(used)) {
    for (const [host, n] of Object.entries(hosts)) parts.push(`${name} to ${host} (${n}x)`);
  }
  return parts.join(', ');
}
