# Challenge setup

The scripts for the public "try to break it" challenge. The rules, and what
counts as a win, are in [docs/CHALLENGE.md](../../docs/CHALLENGE.md).

- `make-flag.mjs` puts a random `FLAG` into a new vault in the current folder
  (allowed site: `postman-echo.com`) and writes its SHA-256 to `flag.sha256`.
  The flag is never printed.
- `check-flag.mjs "facedown{...}"` says whether a claimed flag is the real one.
