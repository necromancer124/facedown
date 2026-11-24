// Run a command with secrets in its environment, redacting its output.

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createRedactor, createStreamRedactor, mergeHits } from './redact.js';

function quoteForCmd(arg) {
  if (arg !== '' && /^[A-Za-z0-9_\-./:=\\@+,]+$/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function spawnArgv(argv, options) {
  if (process.platform === 'win32') {
    // Windows needs a shell to run .cmd/.bat launchers such as npm or npx.
    return spawn(argv.map(quoteForCmd).join(' '), { ...options, shell: true });
  }
  return spawn(argv[0], argv.slice(1), options);
}

/**
 * For the command line: output is streamed to the terminal as it arrives.
 * Resolves with { code, leaks }: the exit code and which keys the program printed.
 */
export function runStreaming(argv, secrets, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnArgv(argv, {
      cwd,
      env: { ...process.env, ...secrets },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const out = createStreamRedactor(secrets, (t) => process.stdout.write(t));
    const err = createStreamRedactor(secrets, (t) => process.stderr.write(t));
    child.stdout.on('data', (c) => out.write(c));
    child.stderr.on('data', (c) => err.write(c));
    child.on('error', (e) => reject(new Error(`cannot start "${argv[0]}": ${e.message}`)));
    child.on('close', (code, signal) => {
      out.end();
      err.end();
      resolve({ code: code ?? (signal ? 1 : 0), leaks: mergeHits(out.hits(), err.hits()) });
    });
  });
}

/**
 * For the MCP server: runs a shell command and returns its (redacted) output
 * as one string, with a size cap and a timeout.
 */
export function runCaptured(command, secrets, { cwd, timeoutMs = 120_000, maxChars = 100_000 } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let rawBytes = 0;
    let truncated = false;
    let timedOut = false;

    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...secrets },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // stdout and stderr are cleaned separately, each with its own decoder:
    // a secret written to stdout in two parts with stderr text in between, or
    // a multi-byte character cut between two chunks, must still be caught.
    const streams = ['stdout', 'stderr'].map((name) => ({
      name,
      redactor: createRedactor(secrets),
      decoder: new StringDecoder('utf8'),
    }));
    for (const s of streams) {
      child[s.name].on('data', (chunk) => {
        if (truncated) return;
        rawBytes += chunk.length;
        if (rawBytes > maxChars * 4) {
          truncated = true;
          return;
        }
        output += s.redactor.push(s.decoder.write(chunk));
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const done = (exitCode, startError) => {
      clearTimeout(timer);
      for (const s of streams) {
        // Cut off: keep back an ending that could be the start of a secret.
        output += truncated ? s.redactor.flushIdle() : s.redactor.finish(s.decoder.end());
      }
      // Redacted first, cut second, so a cut never splits a secret.
      if (output.length > maxChars) {
        output = output.slice(0, maxChars);
        truncated = true;
      }
      const leaks = mergeHits(...streams.map((s) => s.redactor.hits()));
      resolve({ exitCode, output, truncated, timedOut, startError, leaks });
    };

    child.on('error', (e) => done(null, e.message));
    child.on('close', (code) => done(code));
  });
}
