# Python example: list your GitHub repos

The program reads `GITHUB_TOKEN` from the environment like any other program.
facedown puts it there for this one run; the value never appears in your
project, in a `.env` file, or in front of an AI agent.

Needs Python 3.8 or newer. Only the standard library; the comment at the top of `main.py` shows the same call with `requests`.

## Run it

In this folder, store the token once (you type it with hidden input, or in a
window when an AI runs the command):

```bash
facedown set GITHUB_TOKEN --desc "GitHub API token" --allow api.github.com
```

Then run the program with that key:

```bash
facedown run --keys GITHUB_TOKEN -- python main.py
```

## What you see

```
[debug] using token ***GITHUB_TOKEN***
public   you/some-repo
private  you/another-repo
facedown: note: hid the value of GITHUB_TOKEN (1x) in the output. Logs show the key name instead of the value.
```

The program prints the token on purpose, to show what happens: the output has
the key name instead of the value. With a wrong token GitHub answers
`401: Bad credentials`.

## From an AI agent

Ask the agent to run it. It calls `run_with_secrets` with
`keys: ["GITHUB_TOKEN"]`, or runs the `facedown run` command above. Either
way it gets the repo list and never the token.
