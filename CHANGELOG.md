# Changelog

All notable changes to facedown. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org). What counts as the public surface
is in [docs/STABILITY.md](docs/STABILITY.md).

## [Unreleased]

### Added
- `facedown export FILE` and `facedown import FILE` move a vault to another
  computer. The export is encrypted with a passphrase only the user can type
  (in a window, or a terminal on Linux and macOS); there is no MCP tool for it.
- `facedown run --all-keys` passes every key on purpose.
- `facedown migrate` renames a vault from before the rename (`.aienv`) to
  `.env.facedown`. Commands that find an old-name vault say so once.
- [docs/STABILITY.md](docs/STABILITY.md): what stays stable from 1.0 on, and a
  test that fails if a command, flag or tool disappears.
- Releases are published to npm from GitHub Actions with provenance, after the
  tests pass and the tag matches every version (see
  [docs/RELEASING.md](docs/RELEASING.md)).

### Changed
- **Breaking:** without a terminal (for example when an AI runs it),
  `facedown run` needs `--keys A,B` or `--all-keys` instead of silently passing
  every secret. In your own terminal it works as before.
- Saving takes a lock file (`.env.facedown.lock`) and re-reads the vault first,
  so the MCP server and the CLI saving at the same moment never lose a change.

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
  (`.aienv`, `~/.blind-env`) keep working. The first release was published to
  npm as `blind-env@0.1.0`.
