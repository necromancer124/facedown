# Using facedown with other AI tools

`facedown mcp` is a standard MCP server (stdio), so any tool that supports MCP
can use it. Claude Code has the plugin; this page is for everything else.

> **Status:** the Claude Code setup is tested. For the others, the server side
> is tested on Windows: started without a shell the way these tools start it,
> `cmd /c npx -y facedown mcp` answers (about 15 s the first time, while npx
> downloads it) and uses `FACEDOWN_DIR`, while a plain `"command": "npx"` fails
> to start. The steps inside each app have **not been tried yet**
> ([issue #7](https://github.com/necromancer124/facedown/issues/7)). If one
> works or fails for you, please say so there.

**On Windows**, write the command as `"command": "cmd", "args": ["/c", "npx",
"-y", "facedown", "mcp"]`: many tools start servers without a shell, and then
`npx` alone cannot be found. On macOS and Linux, `"command": "npx", "args":
["-y", "facedown", "mcp"]` is enough. The snippets below use the Windows form.

## Which vault does the server use?

A vault belongs to a project folder. The server looks, in this order:

1. `FACEDOWN_DIR`, if set (and its parent folders);
2. the folder the server was started in;
3. `CLAUDE_PROJECT_DIR` (set by Claude Code).

Most editors don't start MCP servers in your project folder, so the snippets
below set `FACEDOWN_DIR` to the open workspace. Ask the agent to call
`list_keys` first: its first line says which vault it uses.

## Cursor

In your project, create `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "facedown": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "facedown", "mcp"],
      "env": { "FACEDOWN_DIR": "${workspaceFolder}" }
    }
  }
}
```

Then enable the server under *Cursor Settings → MCP*.

## VS Code (Copilot agent mode)

In your project, create `.vscode/mcp.json`:

```json
{
  "servers": {
    "facedown": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "npx", "-y", "facedown", "mcp"],
      "env": { "FACEDOWN_DIR": "${workspaceFolder}" }
    }
  }
}
```

Start it from the *Start* link that appears above the server in that file, then
pick the tools in Copilot Chat's agent mode.

## Claude Desktop

Claude Desktop has no project folder, so name it. Open *Settings → Developer →
Edit Config* (the file is `%APPDATA%\Claude\claude_desktop_config.json` on
Windows) and add:

```json
{
  "mcpServers": {
    "facedown": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "facedown", "mcp"],
      "env": { "FACEDOWN_DIR": "C:\\Users\\you\\code\\my-project" }
    }
  }
}
```

Restart Claude Desktop. To switch projects, change `FACEDOWN_DIR`.

## If the server does not start

- **Windows, `spawn npx ENOENT` or `EINVAL`:** the tool started `npx` without a
  shell. Use the `cmd /c` form above, or install facedown once
  (`npm install -g facedown`) and use
  `"command": "node", "args": ["<npm global folder>/facedown/src/cli.js", "mcp"]`
  (`npm root -g` prints that folder). The `node` form starts in about a second.
- **"There is no vault yet":** the server is looking in the wrong folder. Check
  `FACEDOWN_DIR`, then call `list_keys` again.
- The windows (password, confirmations) open on your screen whichever tool
  starts the server.

## Any other MCP client

Run `facedown mcp` (or `npx -y facedown mcp`) as a stdio server, with
`FACEDOWN_DIR` set to your project folder. The six tools are described in the
[README](../README.md#for-other-ai-agents-mcp-server) and
[docs/STABILITY.md](STABILITY.md).
