# FAQ and troubleshooting

**First step for any problem:** run `facedown doctor`. It checks the whole
setup and says what's wrong in plain words.

## Setup

### The slash commands (`/addKey`, `/keys`, …) don't show up

Start a new Claude Code session after installing the plugin; a running session
does not pick up new commands. If you use this repo without the plugin, the
session has to **start** in the repo folder: one that starts elsewhere does not
load `.mcp.json` and `.claude/commands/` until it moves there.

### "There is no vault yet"

A vault belongs to a project folder (`.env.facedown` in that folder or a parent
folder). The MCP server looks in the folder it was started in, or in
`FACEDOWN_DIR`. Start your AI session in the project folder, or set
`FACEDOWN_DIR` (see [CLIENTS.md](CLIENTS.md) for editors). `add_key` creates the
vault on first use, and `list_keys` shows which vault is in use.

### "this vault still has its old name (.aienv)"

The project used to be called blind-env, and its vaults were called `.aienv`.
They keep working. `facedown migrate` renames the file to `.env.facedown`;
nothing else changes.

## Errors

### "no key for this vault on this computer"

The vault file is here, but its unlock key is not. The key is stored in your
home folder (`~/.facedown/keys`) and, on Windows, locked to your Windows
account. This happens when the project was copied from another computer or
account, or the key folder was deleted.

- If you still have the original computer: run `facedown export backup.facedown`
  there and `facedown import backup.facedown` here (in a folder without that
  vault, or after removing the copied `.env.facedown`).
- Otherwise the values cannot be recovered. Delete `.env.facedown` and add the
  secrets again with `facedown set NAME`.

### "cannot decrypt NAME: the vault file was changed by hand"

Each key's allowed sites (the `# @allow` line) are part of its encryption, so
editing that line by hand breaks the key on purpose: otherwise anyone who can
edit the file could send the key to a new site. Undo the edit (your editor's
undo, or `git checkout .env.facedown`), and change sites with
`facedown allow NAME site…` or `/allowSite` instead. If the original line is
lost, set the key again: `facedown set NAME`.

### "the vault is busy: another facedown is saving it"

Saving takes a lock file (`.env.facedown.lock`) for a few milliseconds. If you
see this, another facedown was saving at the same moment; try again. A lock
left behind by a crash is removed automatically after 30 seconds. If it keeps
happening and no facedown is running, delete the `.lock` file.

### "say which keys the program needs, like --keys A,B"

Without a terminal (which is how AI agents run commands), `facedown run` only
passes the keys you name, so a program never gets more secrets than it needs:
`facedown run --keys GITHUB_TOKEN -- node app.js`. `--all-keys` passes every
key on purpose. In your own terminal, leaving out `--keys` still passes all.

## Using it

### Why is `echo %NAME%` (or `$NAME`) refused?

Expanding a key in the command itself puts the real value on a command line,
for example `curl -H "Authorization: Bearer %TOKEN%"`. Other programs on the
same computer can read any process's command line (Task Manager, `ps`), and
facedown can't hide it there, so `run` and `run_with_secrets` refuse it. Read
the key inside your program instead (`process.env.NAME`, `os.environ["NAME"]`),
use `http_request` for web APIs, or add `--proxy` (`proxy: true`): then the
command line only gets a placeholder. Mentioning the name as text
(`echo TOKEN is set`) is fine.

### Why are short values refused?

A value is hidden in output by replacing it with `***NAME***`. For a short
value that gives it away: `test` hidden inside `testing` prints
`***NAME***ing`, and anyone can guess it. So values under 8 characters are
refused unless you add `--allow-short` (for real short values like a PIN).
Values under 4 characters are not hidden at all.

### How do I rotate (replace) a key?

facedown can't revoke a key at GitHub, OpenAI and so on; that stays at the
provider. A short routine:

1. Create a new key at the provider.
2. `facedown set NAME` and type the new value (it replaces the old one, and
   keeps the note and allowed sites).
3. Revoke the old key at the provider.
4. `facedown check NAME`: the fingerprint changed, so you know the new value
   is in.

`facedown list` shows when each value was last set ("set 94 days ago"), and
`facedown doctor` points out keys that haven't changed in over 180 days. If a
key might have leaked, rotate it first, then look at `facedown log NAME` to see
where it was used.

### Should I commit `.env.facedown`?

You can. The values are encrypted and the key is not in the project, so the
file is useless without your computer. Keep in mind it only opens on the
computer that made it, so a teammate who clones the repo cannot use it (they
keep their own vault). Commit it if you want its names, notes and allowed sites
under version control; otherwise add it to `.gitignore`.

### Can my teammates use my vault?

Not yet: each vault opens only on the computer that made it. Each person keeps
their own vault with the same key names, so the code works for everyone.
`facedown export` and `import` move a vault between your own computers.

### Can the AI really not get a value?

Not through facedown: there is no command or tool that prints a value. But an
AI with a full shell runs as you, and could work around it on purpose. See
"What it protects, and what it does not" in the [README](../README.md).
