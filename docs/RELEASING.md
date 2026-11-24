# Making a release

Releases are published to npm by GitHub Actions
([`.github/workflows/release.yml`](../.github/workflows/release.yml)), never
from a laptop. That way every version on npm carries a **provenance** badge:
proof that it was built from this repository, at the tagged commit.

## One-time setup (owner)

1. **Trusted publishing (recommended, no token to leak).** On npmjs.com open
   the `facedown` package → *Settings* → *Trusted publishing* → *GitHub
   Actions*, and enter:
   - Organization or user: `necromancer124`
   - Repository: `facedown`
   - Workflow filename: `release.yml`
   - Environment: `npm`

   The package already exists on npm (0.1.0 was published by hand), so this
   can be set up right away.
2. **Or a token.** Create a granular access token on npmjs.com with publish
   rights for `facedown` only, and add it in GitHub → *Settings* → *Secrets and
   variables* → *Actions* as `NPM_TOKEN`. Remove the secret once trusted
   publishing works.
3. In GitHub → *Settings* → *Environments*, create an environment called `npm`.
   Optionally add yourself as a required reviewer, so every publish waits for
   your click.

## Every release

1. Pick the version (`MAJOR.MINOR.PATCH`, see [STABILITY.md](STABILITY.md)).
2. Set it in these places (the tests fail if they differ):
   - `package.json` → `version`
   - `.claude-plugin/plugin.json` → `version`
   - `.claude-plugin/marketplace.json` → `plugins[0].version`
   - `server.json` → `version` and `packages[0].version` (the MCP Registry listing)
3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and
   start a new empty `## [Unreleased]` above it.
4. Run `npm test`, commit, then tag and push:

   ```bash
   git tag vX.Y.Z
   ```
   ```bash
   git push origin main vX.Y.Z
   ```

The workflow runs the tests on Windows (Node 20, 22, 24), then refuses to
publish if the tag does not match all three versions or the changelog has no
section for it. After publishing it creates the GitHub release with that
changelog section as the notes.

## A security fix

1. Release the fix as above (a patch version is fine).
2. Mark every affected version on npm, with a message that starts with
   `SECURITY`:

   ```bash
   npm deprecate facedown@"<X.Y.Z" "SECURITY: short description. Update to X.Y.Z or newer."
   ```

   facedown's daily update check reads this message: every user of an older
   version sees a loud warning, and anyone who set `FACEDOWN_BLOCK_INSECURE=1`
   is stopped until they update. `npm install` shows it too.
3. Publish a GitHub security advisory (repository → *Security* → *Advisories*)
   with the affected and fixed versions, so `npm audit` and Dependabot flag it.

Only use `SECURITY` for real security problems: it is the one message
facedown makes loud.
