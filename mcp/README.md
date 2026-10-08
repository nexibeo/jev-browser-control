# Jev Browser Control

Let Claude drive a real Chrome window. Ask in plain words ("search Google for the Rijksmuseum opening hours", "fill in this order form but stop before you submit") and Claude opens pages, reads them, clicks, types and fills in forms in a Chrome window on your computer. For multi-step work, Jev, TypeSafe's fast decision model, picks each step in about half a second for a fraction of a cent, so Claude spends its own effort on planning and checking the result.

![Jev Browser Control](assets/logo.png)

This folder is both the Claude Code plugin and the `jev-browser-control-mcp` package for other MCP clients (Codex, Claude Desktop and others). Website: [jevbrowsercontrol.com](https://jevbrowsercontrol.com) · [How to](https://jevbrowsercontrol.com/how-to) · [Docs](https://jevbrowsercontrol.com/docs) · [Demo video](https://youtu.be/t4EBCQbVsF4)

## What you get

- **Browser tools**: open a URL, read the page as numbered elements or as markdown, click, type, choose from dropdowns, press keys, scroll, go back, wait for text, take a screenshot, hover to open menus, read what a "Copy link" menu copied, record the browser screen as an MP4, and list, switch or close tabs.
- **`jev_task`**: hands a whole multi-step job (a search, filters, a form) to Jev, which runs it step by step and reports each action, the cost and the final page. `jev_find` and `jev_check` are single low-cost Jev calls that locate an element or rate a statement about the page.
- **A skill and a subagent** (plugin only) that teach Claude when to use the browser, which tool fits, and the safety rules. The subagent does browser work on its own and reports back briefly, so page contents stay out of your main conversation.

## Install

You need Google Chrome, and Node.js 18 or newer with npm.

**Claude Code plugin**

```
/plugin marketplace add nexibeo/jev-browser-control
/plugin install jev-browser-control@jev-browser-control
```

Claude Code asks for your Jev Browser Control key when you enable the plugin. You can change it, or switch confirmations off, later under `/plugin`, Jev Browser Control, Configure.

**Any MCP client** (Claude Code without the plugin, Codex, Claude Desktop):

```bash
claude mcp add -s user -e JBC_API_KEY=jbc_your_key jev-browser -- npx -y https://jevbrowsercontrol.com/downloads/jev-browser-control-mcp-0.4.2.tgz
```

```bash
codex mcp add jev-browser --env JBC_API_KEY=jbc_your_key -- npx -y https://jevbrowsercontrol.com/downloads/jev-browser-control-mcp-0.4.2.tgz
```

**Your key and credits.** Jev runs on prepaid credits from Jev Browser Control. Create an account and copy your `jbc_` key in the [dashboard](https://jevbrowsercontrol.com/dashboard); add credits there from $10. A task costs a fraction of a cent: the five tasks in the [demo video](https://youtu.be/t4EBCQbVsF4) cost $0.003 to $0.007 each. Your balance shows when Claude checks the browser status, and Claude tells you when credits run low; you add more in the same dashboard. Without a key the `browser_*` tools still work; only the `jev_*` tools need credits.

Then ask Claude to use the browser. A Chrome window opens on the first tool call. When a site needs a login, sign in there yourself once; the window has its own profile and keeps the logins for next time.

## What runs on your computer, and what is sent where

- **What runs.** The plugin starts `node server.mjs` from this folder. When you install the plugin, Claude Code installs its one dependency, `playwright-core`, from npm at the exact version pinned in `package-lock.json`. The server uses it to start your installed Google Chrome with a separate profile in `~/.jev-browser-control/chrome-profile`, apart from your everyday Chrome profile. `browser_record` also runs `ffmpeg`, when it is installed, to turn the recorded frames into an MP4.
- **Local only.** The server listens on `127.0.0.1:10523`, so several Claude Code or Codex sessions share one Chrome window. It accepts other Jev Browser Control processes on your computer that hold the token in `~/.jev-browser-control` (and, in extension mode, the extension); web pages can't connect.
- **What is sent.** The `browser_*` tools send nothing anywhere; Chrome loads the pages you ask for as usual. When `jev_task`, `jev_find` or `jev_check` run, the server sends the page's visible text, its list of buttons, links and fields (with labels and current values; password and file fields are never included), your goal and the details you gave to jevbrowsercontrol.com, which charges your credits and forwards it to OpenRouter. OpenRouter routes Jev calls to TypeSafe and text calls to the text model's provider. jevbrowsercontrol.com does not store the content. When Claude checks the browser status, the server also asks jevbrowsercontrol.com for your balance. See the [privacy policy](https://jevbrowsercontrol.com/privacy).
- **What is stored.** Your settings in `~/.jev-browser-control/config.env`, the browser profile (cookies and logins of the sites you use there), and recordings in `~/.jev-browser-control/recordings`. No telemetry.

## Safety

- Clicks that buy, pay, send, post or delete, and a Comment or Reply button that would publish typed text, stop `jev_task` with `needs_confirmation`, so Claude asks you first. To let tasks run end to end, switch "Ask before buying, sending, posting or deleting" off in the plugin settings (or set `JBC_CONFIRM_IRREVERSIBLE=0`).
- Password fields are hidden from the tools, and Jev only types values that are in your request.
- Each task has limits on actions, seconds and dollars (`JBC_MAX_STEPS`, `JBC_MAX_SECONDS`, `JBC_MAX_COST_USD`; 30 actions, 120 s and $0.10 by default). `JBC_BLOCKED_SITES` keeps the browser away from sites such as your bank.
- Page text is treated as data, never as instructions.

## Settings

In `~/.jev-browser-control/config.env` or the environment: `CHROME_PATH` or `JBC_CHROME_CHANNEL` (chrome, chrome-beta, msedge, chromium), `JBC_HEADLESS=1`, `JBC_PROFILE_DIR`, `JBC_MAX_STEPS`, `JBC_MAX_SECONDS`, `JBC_MAX_COST_USD`, `JBC_CONFIRM_IRREVERSIBLE=0`, `JBC_BLOCKED_SITES`, `JBC_JEV_MODEL`, `JBC_TEXT_MODEL`, `JBC_PORT`, `JBC_HOME`, `JBC_DEBUG=1`.

**Extension mode** (`JBC_MODE=extension`) drives your everyday Chrome, with your normal profile and open tabs, through the Jev Browser Control extension instead of a separate window. The server then opens a bridge on `127.0.0.1:10522` for the extension. Install the extension first: [jevbrowsercontrol.com/docs#extension](https://jevbrowsercontrol.com/docs#extension). `browser_clipboard` and `browser_record` work in the server's own window only.

## Support and source

Questions and bugs: [GitHub issues](https://github.com/nexibeo/jev-browser-control/issues) or contact@jevbrowsercontrol.com. Source: [github.com/nexibeo/jev-browser-control](https://github.com/nexibeo/jev-browser-control). MIT license.

Jev Browser Control is an independent open-source project by [Nexibeo](https://nexibeo.com), created by [Jeroen Erne](https://www.linkedin.com/in/jeroenerne/) ([completeaitraining.com](https://completeaitraining.com)) and built together with Claude. Jev is a model by TypeSafe; this project is not affiliated with TypeSafe or Anthropic.
