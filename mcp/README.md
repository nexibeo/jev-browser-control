# jev-browser-control-mcp

MCP server for [Jev Browser Control](https://jevbrowsercontrol.com): lets Claude Code, Claude Desktop and other MCP clients control your own Chrome through the Jev Browser Control extension. Node.js 22+, no dependencies.

```bash
claude mcp add jev-browser -- npx -y https://jevbrowsercontrol.com/downloads/jev-browser-control-mcp-0.2.0.tgz
```

The server speaks MCP over stdio and opens a bridge on `127.0.0.1:10522` that the extension connects to. Install the extension first: [jevbrowsercontrol.com/docs#install](https://jevbrowsercontrol.com/docs#install).

Tools: `browser_status`, `browser_tabs`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`, `browser_press_key`, `browser_scroll`, `browser_back`, `browser_wait`, `browser_read`, `browser_screenshot`, `jev_task`, `jev_find`, `jev_check`, `jev_stop`.

Environment: `JBC_PORT` (default 10522), `JBC_EXTENSION_IDS` (allowlist), `JBC_HOME`, `JBC_DEBUG=1`.

Source and docs: [github.com/nexibeo/jev-browser-control](https://github.com/nexibeo/jev-browser-control). MIT license.

Created by [Jeroen Erne](https://www.linkedin.com/in/jeroenerne/) ([nexibeo.com](https://nexibeo.com) · [completeaitraining.com](https://completeaitraining.com)), built together with Claude.
