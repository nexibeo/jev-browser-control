# Agent files for Claude Code and Codex

Ready-made files that teach Claude Code and OpenAI Codex how to use Jev Browser Control well.

| File | For | What it does |
| --- | --- | --- |
| [`skills/jev-browser/SKILL.md`](skills/jev-browser/SKILL.md) | Claude Code and Codex | A skill: when to use the browser, which tool fits, how to write a `jev_task`, what each result status means, and the safety rules |
| [`claude-code/jev-browser.md`](claude-code/jev-browser.md) | Claude Code | A subagent that does browser work on its own and reports back briefly, so page contents stay out of your main conversation |

Both need the extension installed and the MCP server registered under the name `jev-browser`.

## One command

From a clone of this repo (Node 18+):

```bash
node scripts/install-agents.mjs
```

It registers the MCP server for Claude Code (user scope) and Codex, and copies the skill and the subagent into `~/.claude` and `~/.codex`. Options: `--claude` or `--codex` for one of them, `--npx` to run the server from the published tarball instead of your clone, `--dry-run` to see the steps, `--uninstall` to remove it all.

## By hand

**Claude Code**

```bash
claude mcp add -s user jev-browser -- npx -y https://jevbrowsercontrol.com/downloads/jev-browser-control-mcp-0.2.0.tgz
mkdir -p ~/.claude/agents ~/.claude/skills
cp agents/claude-code/jev-browser.md ~/.claude/agents/
cp -R agents/skills/jev-browser ~/.claude/skills/
```

Then ask Claude to "use the jev-browser agent to …", or just describe a browser task.

**Codex** (CLI or the Codex app)

```bash
codex mcp add jev-browser -- npx -y https://jevbrowsercontrol.com/downloads/jev-browser-control-mcp-0.2.0.tgz
mkdir -p ~/.codex/skills
cp -R agents/skills/jev-browser ~/.codex/skills/
```

Or add it to `~/.codex/config.toml` yourself:

```toml
[mcp_servers.jev-browser]
command = "npx"
args = ["-y", "https://jevbrowsercontrol.com/downloads/jev-browser-control-mcp-0.2.0.tgz"]
startup_timeout_sec = 60
```

Claude Code and Codex can run at the same time: the first MCP server owns the bridge and the others join it, so they share one browser.
