# Changelog

All notable changes to facedown. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org). What counts as the public surface
is in [docs/STABILITY.md](docs/STABILITY.md).

## [Unreleased]

## [0.3.0] - 2026-11-25

### Added
- `facedown run --proxy` and `run_with_secrets` with `proxy: true`
  (experimental): the program gets placeholders instead of keys, and a local
  proxy puts the real key only into HTTPS requests to that key's allowed sites,
  so a key on a command line or in a file is only the placeholder. Works with
  Node 24 `fetch`, Python (`requests`, `urllib`) and curl (also on Windows).
  Idea from a discussion with u/Deynekin on r/mcp (#23).
- README: a Thanks section for people whose ideas shaped facedown.
- `Dockerfile` and `glama.json`, so MCP directories such as Glama can start
  the server and list its tools, and the listing can be claimed.

### Fixed
- Base64 of a longer text that contains a secret (`Bearer <key>`, HTTP Basic
  `user:<key>`) is now hidden too; before, only base64 of the secret on its own
  was. Found by the `--proxy` tests.

## [0.2.1] - 2026-11-24

### Added
- Listed in the official MCP Registry as `io.github.necromancer124/facedown`
  (`server.json`, and `mcpName` in `package.json`). Each release now updates the
  listing from GitHub Actions.

### Changed
- [docs/CLIENTS.md](docs/CLIENTS.md): on Windows the snippets use
  `cmd /c npx`, because `npx` alone cannot be started by tools that start
  servers without a shell.

## [0.2.0] - 2026-11-24

### Added
- `facedown export FILE` and `facedown import FILE` move a vault to another
  computer. The export is encrypted with a passphrase only the user can type
  (in a window, or a terminal on Linux and macOS); there is no MCP tool for it.
- `facedown run --all-keys` passes every key on purpose.
- `facedown migrate` renames a vault from before the rename (`.aienv`) to
  `.env.facedown`. Commands that find an old-name vault say so once.
- [docs/STABILITY.md](docs/STABILITY.md): what stays stable from 1.0 on, and a
  test that fails if a command, flag or tool disappears.
- [docs/FAQ.md](docs/FAQ.md), [docs/CLIENTS.md](docs/CLIENTS.md) (Cursor,
  VS Code, Claude Desktop) and runnable examples in `examples/` (Node and
  Python).
- Update notice: once a day facedown checks npm for a newer version and says
  so after a command and in `list_keys`. A version marked on npm with a
  `SECURITY` message gets a loud warning; `FACEDOWN_BLOCK_INSECURE=1` makes it a
  hard stop for commands that use secrets. `FACEDOWN_NO_UPDATE_CHECK=1` (or CI)
  turns the check off. Never updates by itself; offline it stays quiet.
- Releases are published to npm from GitHub Actions with provenance, after the
  tests pass and the tag matches every version (see
  [docs/RELEASING.md](docs/RELEASING.md)).

### Fixed
- Two overlapping secrets could leak: if one secret ends with the first
  characters of another, printing the start of the first followed by the
  second hid the first and showed most of the second. Found by the new random
  stress test (`test/fuzz.test.js`), which runs in CI.
- `run_with_secrets` could show a secret when a program wrote it to stdout in
  two parts with a line on stderr in between, or when a non-ASCII character in
  the secret was cut between two pieces of output. stdout and stderr are now
  cleaned separately, each with its own decoder.

### Changed
- **Breaking:** without a terminal (for example when an AI runs it),
  `facedown run` needs `--keys A,B` or `--all-keys` instead of silently passing
  every secret. In your own terminal it works as before.
- Saving takes a lock file (`.env.facedown.lock`) and re-reads the vault first,
  so the MCP server and the CLI saving at the same moment never lose a change.
- The update notice in `list_keys` is quoted as text from npm, so an agent
  treats it as data, not instructions.

## [0.1.0] - 2026-11-10

First preview, Windows first.

### Added
- Encrypted vault `.env.facedown` (AES-256-GCM); the unlock key is kept in
  `~/.facedown/keys`, protected with DPAPI on Windows.
- Command line: `init`, `set`, `list`, `rm`, `allow`, `check`, `run`, `mcp`.
- MCP server with `list_keys`, `add_key`, `run_with_secrets`, `http_request`,
  `remove_key` and `allow_hosts`.
- Claude Code plugin with `/addKey`, `/keys`, `/removeKey`, `/allowSite` and
  `/removeSite`.
- Output cleaning: printed secrets show as `***NAME***`, including base64, hex
  and URL-encoded forms; `--strict` and `--quiet`.
- Allowed sites per key, protected by the encryption; adding one always needs
  the user's click.

### Changed
- Renamed from **blind-env** to **facedown**. Vaults made by blind-env
  (`.aienv`, `~/.blind-env`) keep working. 0.1.0 is on npm both as
  `blind-env@0.1.0` and `facedown@0.1.0`.
