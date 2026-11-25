// --proxy mode: placeholders for the program, the real key only in requests
// to an allowed site. A fake "real site" (HTTPS, its own private CA) echoes
// what it receives, like a careless API would.

import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { after, before, test } from 'node:test';
import tls from 'node:tls';
import { createAuthority } from '../src/certs.js';
import { describeUse, startSecretProxy } from '../src/proxy.js';

const SECRET = 'sk-proxy-test-1234567890';
const siteCa = createAuthority('test site CA');
let site;
let sitePort;
let lastSeen;
let plainSite;
let plainPort;

const echo = (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastSeen = { host: req.headers.host, auth: req.headers.authorization, body };
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-echo-auth', req.headers.authorization ?? '');
    res.end(JSON.stringify({ auth: req.headers.authorization, body, b64: Buffer.from(req.headers.authorization ?? '').toString('base64') }));
  });
};

before(async () => {
  // One server answers as both "localhost" and "127.0.0.1", with certificates from the site CA.
  site = https.createServer(
    {
      SNICallback: (name, cb) => cb(null, tls.createSecureContext(siteCa.issue(name || '127.0.0.1'))),
      ...siteCa.issue('127.0.0.1'),
    },
    echo
  );
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  sitePort = site.address().port;
  plainSite = http.createServer(echo);
  await new Promise((r) => plainSite.listen(0, '127.0.0.1', r));
  plainPort = plainSite.address().port;
});
after(() => {
  for (const s of [site, plainSite]) {
    s.closeAllConnections();
    s.close();
  }
});

/** Make an HTTPS request through the proxy the way curl or requests would. */
function viaProxy(proxyUrl, trustPem, { host, port, method = 'POST', headers = {}, body = '' }) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const connect = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${host}:${port}` });
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`CONNECT ${res.statusCode}`));
      const secure = tls.connect({ socket, host, servername: host === '127.0.0.1' ? undefined : host, ca: trustPem }, () => {
        const lines = [`${method} /echo HTTP/1.1`, `Host: ${host}:${port}`, 'Connection: close', `Content-Length: ${Buffer.byteLength(body)}`];
        for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
        secure.write(lines.join('\r\n') + '\r\n\r\n' + body);
      });
      let raw = '';
      secure.on('data', (c) => (raw += c));
      secure.on('end', () => {
        const [head, ...rest] = raw.split('\r\n\r\n');
        const [statusLine, ...headerLines] = head.split('\r\n');
        const resHeaders = Object.fromEntries(
          headerLines.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()])
        );
        resolve({ status: Number(statusLine.split(' ')[1]), headers: resHeaders, body: rest.join('\r\n\r\n') });
      });
      secure.on('error', reject);
    });
    connect.on('error', reject);
    connect.end();
  });
}

test('proxy: the program gets a placeholder; an allowed site gets the real key; the reply hides it', async () => {
  const p = await startSecretProxy({ secrets: { TOKEN: SECRET }, allow: { TOKEN: ['localhost'] }, upstreamCa: siteCa.certPem });
  try {
    const ph = p.placeholders.TOKEN;
    assert.match(ph, /^facedown-placeholder-TOKEN-[0-9a-f]{12}$/);
    assert.equal(p.env.TOKEN, ph, 'the program environment holds the placeholder');
    assert.ok(!JSON.stringify(p.env).includes(SECRET), 'the real value is nowhere in the environment');

    const r = await viaProxy(p.url, p.caPem, {
      host: 'localhost',
      port: sitePort,
      headers: { authorization: `Bearer ${ph}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: ph }),
    });
    assert.equal(r.status, 200);
    // The real site got the real key, in the header and the body.
    assert.equal(lastSeen.auth, `Bearer ${SECRET}`);
    assert.equal(JSON.parse(lastSeen.body).token, SECRET);
    // The program never sees it: not in the body, its headers, or base64 of it.
    assert.ok(!r.body.includes(SECRET) && !JSON.stringify(r.headers).includes(SECRET), r.body);
    assert.ok(!r.body.includes(Buffer.from(`Bearer ${SECRET}`).toString('base64')));
    assert.equal(JSON.parse(r.body).auth, `Bearer ${ph}`, 'the echoed key comes back as the placeholder');
    assert.equal(r.headers['x-echo-auth'], `Bearer ${ph}`);
    assert.match(describeUse(p.used), /^TOKEN to localhost \(\dx\)$/);
  } finally {
    await p.close();
  }
});

test('proxy: a site that is not allowed only ever gets the placeholder, through an untouched tunnel', async () => {
  const p = await startSecretProxy({ secrets: { TOKEN: SECRET }, allow: { TOKEN: ['localhost'] }, upstreamCa: siteCa.certPem });
  try {
    const ph = p.placeholders.TOKEN;
    // 127.0.0.1 is not on the list: the proxy does not decrypt, so the program
    // talks to the real site's own certificate (trusted here for the test).
    const r = await viaProxy(p.url, siteCa.certPem, {
      host: '127.0.0.1',
      port: sitePort,
      headers: { authorization: `Bearer ${ph}` },
    });
    assert.equal(r.status, 200);
    assert.equal(lastSeen.auth, `Bearer ${ph}`);
    assert.equal(describeUse(p.used), '');
  } finally {
    await p.close();
  }
});

test('proxy: plain http carries a key only to localhost, never to the internet', async () => {
  const p = await startSecretProxy({ secrets: { TOKEN: SECRET }, allow: { TOKEN: ['localhost', 'example.com'] } });
  try {
    const ph = p.placeholders.TOKEN;
    const proxy = new URL(p.url);
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: proxy.hostname, port: proxy.port, method: 'GET', path: `http://localhost:${plainPort}/echo`, headers: { authorization: `Bearer ${ph}` } },
        (r) => {
          let d = '';
          r.on('data', (c) => (d += c));
          r.on('end', () => resolve(d));
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(lastSeen.auth, `Bearer ${SECRET}`, 'localhost over http is allowed (like http_request)');
    assert.ok(!res.includes(SECRET));
  } finally {
    await p.close();
  }
});

test('certs: certificates are valid, signed by the run CA, and name the host', () => {
  const ca = createAuthority();
  const caCert = new X509Certificate(ca.certPem);
  assert.equal(caCert.ca, true);
  for (const host of ['api.github.com', '127.0.0.1']) {
    const cert = new X509Certificate(ca.issue(host).cert);
    assert.equal(cert.verify(caCert.publicKey), true);
    assert.equal(cert.ca, false);
    assert.ok(cert.checkHost(host) || cert.checkIP(host));
  }
  assert.notEqual(createAuthority().certPem, ca.certPem, 'a new CA every time');
});
