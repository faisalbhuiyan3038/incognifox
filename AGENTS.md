# Firefox testing guide for agents

## Pick the tool

| Task | Use |
|---|---|
| Anything in Firefox: sites, extensions, popups, browser UI, `about:` pages, CSS and chrome JS mods, Cloudflare-protected sites | **`firefox-rdp`** (default) |
| Performance profiles, logpoints, response bodies, Firefox for Android | `firefox-devtools` |
| Chrome or Chromium behaviour | `chrome-devtools` |

`firefox-devtools` runs in automation mode (`navigator.webdriver` is true). Sites using Cloudflare Turnstile, such as goplay.su, hang under it. Never use it for those sites.

If a site still blocks `firefox-rdp`, stop and tell the user. Do not try to solve or bypass the challenge.

## Save tokens

Use the cheapest tool that answers the question:

1. `eval_page` or `eval_chrome`: return only the values you need, and batch several reads into one call.
2. `page_text` with `selector` and a low `max_chars`.
3. `snapshot` with `selector`. Take a new one only after the page changes.
4. `screenshot`: only for visual checks. It returns a file path, so open the image only when you need to see it. Avoid `inline`.

- Read logs narrowly: `console_logs` with `level: "error"`, `network_log` with `filter`, and a small `limit`.
- Pass `clear: true` once logs are read, so the next read shows only new entries.
- Use `wait_for` instead of repeated polling.
- Never dump `document.documentElement.outerHTML` or full preference lists.
- Close tabs you no longer need.

## Workflows

**Web page:** `navigate` → `snapshot` → `click` or `type` with refs → `console_logs` with `level: "error"`.

**Extension:**
1. `ext_install` with the absolute folder or `.xpi` path. It returns `id` and `host`.
2. Background: `ext_eval` with `id` and `code`.
3. Popup: `ext_open_popup`, then `ext_eval` with `page: "popup"`, then `screenshot` with `target: "popup"` if the look matters.
4. Options or other pages: `navigate` to `moz-extension://<host>/options.html`, then use the normal page tools.
5. After editing files: `ext_reload`.

**CSS mod:**
1. Preview with `chrome_css` and `css`. Verify with `eval_chrome` using `getComputedStyle`.
2. Write the result to `<chromeDir>/userChrome.css`. `browser_status` gives `chromeDir`.
3. Apply with `chrome_css` and `reload_disk: true`. Removed rules stay active until `browser_restart`.

**Chrome JS mod:**
1. Prototype with `eval_chrome` (`Services`, `gBrowser` and `document` are the live browser window).
2. Inspect the UI with `snapshot` and `scope: "browser"`. Click it with `click` and `scope: "browser"`.
3. Save the script to `<chromeDir>/JS/name.uc.js`, then call `browser_restart`.

**fx-autoconfig setup:** it needs `config.js` and `defaults/pref/config-prefs.js` beside `firefox.exe`. Do not change the installed Firefox. Use a private copy and point `FX_RDP_BINARY` at it, then copy the loader's `profile/chrome/utils` into `chromeDir`.

## Good to know

- The striped address bar is Firefox's remote-control indicator. It is browser UI only and pages cannot see it. Ignore it when judging CSS mods.
- Temporary extensions are reinstalled after `browser_restart`.
- `click` and `type` work in the top-level document. For iframes, use `x` and `y` coordinates.
- Each running server needs its own profile. For parallel agents, give each one a different `FX_RDP_PROFILE`.
- Never point `FX_RDP_PROFILE` at a personal Firefox profile. The agent has full control of that browser.

## Setup

Requires Node 20+. Claude Code loads the server from `.mcp.json` in this repo. For other clients, register this stdio command:

```
node M:/.systemfile/firefox-testing/firefox-rdp-mcp/server.mjs
```

Codex: `codex mcp add firefox-rdp -- node M:/.systemfile/firefox-testing/firefox-rdp-mcp/server.mjs`

| Variable | Purpose | Default |
|---|---|---|
| `FX_RDP_BINARY` | Firefox executable | Installed Firefox |
| `FX_RDP_PROFILE` | Dedicated profile folder | `~/.firefox-rdp-mcp/profile` |
| `FX_RDP_HEADLESS` | `1` runs without a window | Off |
