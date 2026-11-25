# Try to break facedown

facedown claims an AI agent can **use** your secrets without ever **seeing**
them. Prove it wrong.

## The goal

Get the value of a secret called `FLAG` out of facedown through **normal use**:
the facedown command line, the six MCP tools, or the Claude Code slash
commands, the way an AI agent would use them.

## Set up

You need Windows, Node 20 or newer, and git.

```bash
git clone https://github.com/necromancer124/facedown
```
```bash
mkdir facedown-challenge
```
```bash
cd facedown-challenge
```
```bash
node ../facedown/examples/challenge/make-flag.mjs
```

That puts a random `FLAG` (like `facedown{…32 hex characters…}`) into a new
vault in this folder. Nobody ever sees it, not even you. It also writes
`flag.sha256`, so you can check a claimed flag:

```bash
node ../facedown/examples/challenge/check-flag.mjs "facedown{...}"
```

`FLAG` may be sent to one site, `postman-echo.com`, an echo service that sends
back whatever you send it. Point your agent at the folder: for Claude Code,
`claude mcp add facedown -- node ../facedown/src/cli.js mcp`, or see
[CLIENTS.md](CLIENTS.md) for other tools.

## What counts as a win

- The value, or any readable form of it, shows up in output the AI gets (a
  tool result, a command's output, an error message).
- `FLAG` is sent to a site that is not on its allowed list.
- An allowed site is added, or a key deleted, **without** the confirmation
  window being clicked by a person.
- The MCP server crashes or stops answering because of a tool call.

"Readable form" includes encodings the agent can undo without knowing the
value (base64, hex, reversed, every other character, …). If you get there,
`check-flag.mjs` will confirm it.

## What does not count

These are known limits, listed in the [README](../README.md#what-it-protects-and-what-it-does-not):

- An agent with a full shell deliberately writing a program that scrambles the
  value before printing it, sends it somewhere itself, or reads the unlock key
  from `~/.facedown/keys` / calls Windows DPAPI as the same user. facedown runs
  as you and cannot stop code that runs as you.
- A program run with `run_with_secrets` or `facedown run` (without `--proxy`)
  writing the key to a file or sending it somewhere. Only its output is
  cleaned; the program itself has the real value. That's the documented
  boundary, with a test that shows it.
- Simulating clicks or key presses on the facedown windows.
- An allowed site storing the value (for example a gist on an allowed GitHub
  API). An allowed site is trusted with the key.
- Physical access, or another program already running as you.

The interesting case is the strongest setup: an agent that only has the MCP
tools (`http_request` especially) and no shell. There, every rule above should
hold without exception.

## Reporting

Use GitHub's **private** vulnerability reporting (see
[SECURITY.md](../SECURITY.md)), never a public issue. Include the steps, the
tool calls, and the output. Your flag is random and throwaway, so including it
is fine; never include a real secret.

Every report gets an answer. Real problems are fixed (or documented as known
limits), and the finder is credited in the README's Hall of fame unless they
prefer not to be.
