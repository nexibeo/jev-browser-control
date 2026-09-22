# jev-browser-control-mcp

MCP server for [Jev Browser Control](https://jevbrowsercontrol.com): lets Claude Code, Codex, Claude Desktop and other MCP clients drive a real Chrome, with Jev (TypeSafe's decision model) choosing each click. Node.js 18+ and Google Chrome.

```bash
claude mcp add -s user jev-browser -- npx -y https://jevbrowsercontrol.com/downloads/jev-browser-control-mcp-0.3.0.tgz
```

Put a key in `~/.jev-browser-control/config.env`:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

or `JBC_API_KEY=jbc_...` for jevbrowsercontrol.com credits. Then ask Claude to use the browser.

**Browser mode (default).** The server opens its own Chrome window through Playwright and runs Jev's loop itself. The profile lives in `~/.jev-browser-control/chrome-profile`, so sign in to sites in that window once and the logins stay. Several sessions share the window; when the one that opened it ends, the next takes over.

**Extension mode** (`JBC_MODE=extension`). The server opens a bridge on `127.0.0.1:10522` for the Jev Browser Control extension and drives your everyday Chrome. Install the extension first: [jevbrowsercontrol.com/docs#install](https://jevbrowsercontrol.com/docs#install).

Tools: `browser_status`, `browser_tabs`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`, `browser_press_key`, `browser_scroll`, `browser_back`, `browser_wait`, `browser_read`, `browser_screenshot`, `jev_task`, `jev_find`, `jev_check`, `jev_stop`.

Settings (in `config.env` or the environment): `CHROME_PATH` or `JBC_CHROME_CHANNEL`, `JBC_HEADLESS=1`, `JBC_PROFILE_DIR`, `JBC_MAX_STEPS`, `JBC_MAX_SECONDS`, `JBC_MAX_COST_USD`, `JBC_CONFIRM_IRREVERSIBLE=0`, `JBC_BLOCKED_SITES`, `JBC_JEV_MODEL`, `JBC_TEXT_MODEL`, `JBC_PORT`, `JBC_HOME`, `JBC_DEBUG=1`. Extension mode also takes `JBC_EXTENSION_IDS` (allowlist).

Source and docs: [github.com/nexibeo/jev-browser-control](https://github.com/nexibeo/jev-browser-control). MIT license.

Created by [Jeroen Erne](https://www.linkedin.com/in/jeroenerne/) ([nexibeo.com](https://nexibeo.com) · [completeaitraining.com](https://completeaitraining.com)), built together with Claude.
