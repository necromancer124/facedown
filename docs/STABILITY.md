# What stays stable

facedown follows [semantic versioning](https://semver.org). From **1.0** on,
everything on this page keeps working within a major version: an update never
breaks a vault, a script, a plugin setup or an agent that uses it. Removing or
changing any of it needs a new major version (2.0) and a note in
[CHANGELOG.md](../CHANGELOG.md).

Before 1.0, minor versions (0.2, 0.3, …) may still change these things. Every
change is listed in the changelog.

New things (a command, a flag, a tool, an optional tool argument) can be added
in any minor version.

`test/surface.test.js` fails if a command, flag, tool or tool argument on this
page disappears by accident.

## The vault file `.env.facedown`

```ini
# facedown vault v1 id=<vault id>

# @desc what the secret is for
# @allow api.example.com,*.example.org
NAME=enc:v2:<base64url>
```

- The header line `# facedown vault v1 id=…` (older files say `blind-env`
  instead of `facedown`; they keep opening).
- `# @desc` and `# @allow` lines belong to the key on the next line.
- Values `enc:v1:` (old, allowed sites not protected) and `enc:v2:` (allowed
  sites are part of the encryption). New values are always written as the
  newest format; older ones keep opening.
- The legacy file name `.aienv` keeps being found and read.
- The unlock key lives in `~/.facedown/keys/<vault id>.key` (keys in
  `~/.blind-env/keys/` are copied there on first use).
- Other comment lines are facedown's own and may change.

## The export file

`facedown export` writes JSON with `"format": "facedown-export"` and
`"version": 1`. Every later version can import a version 1 file.

## Command line

| Command | Flags |
|---|---|
| `facedown init` | |
| `facedown set NAME` | `--desc`, `--allow`, `--stdin`, `--allow-short` |
| `facedown list` (also `ls`) | `--json` |
| `facedown rm NAME` (also `remove`) | |
| `facedown allow NAME host…` | `--clear` |
| `facedown check [NAME…]` | |
| `facedown run -- command` | `--keys`, `--all-keys`, `--strict`, `--quiet` |
| `facedown export FILE` | |
| `facedown import FILE` | |
| `facedown migrate` | |
| `facedown mcp` | |
| `facedown help`, `--version` | |

- `list --json` prints an array of `{ "name", "description", "allow" }`.
  Fields may be added, never removed or renamed.
- Exit codes: `0` success, `1` error or cancelled, `97` a secret was printed
  while `--strict` (or `FACEDOWN_STRICT=1`) was on. For `run`, any other code is
  the program's own exit code.
- Messages printed for people (notes, warnings, errors) are not part of the
  promise and may be reworded. Masks in output keep the form `***NAME***` and
  `***NAME:encoding***`.

**Never added, in any version:** a command or tool that prints, returns or
decrypts a secret value.

## MCP tools

| Tool | Arguments (required in bold) |
|---|---|
| `list_keys` | none |
| `add_key` | **`name`**, `description`, `allow` |
| `run_with_secrets` | **`command`**, **`keys`**, `cwd`, `timeout_seconds` |
| `http_request` | **`url`**, `method`, `headers`, `body` |
| `remove_key` | **`name`** |
| `allow_hosts` | **`name`**, `add`, `remove` |

Placeholders in `http_request` keep the form `{{KEY_NAME}}`. The text a tool
returns is for the agent to read, not for a program to parse, and may be
reworded.

## Claude Code plugin

The slash commands `/addKey`, `/keys`, `/removeKey`, `/allowSite` and
`/removeSite`.

## Environment variables

| Variable | What it does |
|---|---|
| `FACEDOWN_HOME` | Folder for unlock keys instead of `~/.facedown` |
| `FACEDOWN_FILE` | Use this vault file instead of searching for one |
| `FACEDOWN_DIR` | Folder the MCP server looks for a vault in |
| `FACEDOWN_STRICT=1` | Every `run` is `--strict` |
| `FACEDOWN_NO_WINDOW=1` | Never open a window (anything needing approval is refused) |
| `FACEDOWN_NO_DPAPI=1` | Windows: store the key without DPAPI (tests only) |
| `FACEDOWN_SKIP_DIR` | Set by the plugin: never use a vault inside this folder |
| `FACEDOWN_NO_UPDATE_CHECK=1` | Never ask npm for a newer version (also off when `CI` is set) |
| `FACEDOWN_BLOCK_INSECURE=1` | Refuse to use secrets while this version has a known security problem |
| `FACEDOWN_UPDATE_URL` | Ask this registry URL instead of `https://registry.npmjs.org/facedown` |

Other `FACEDOWN_*` variables are internal and may change.
