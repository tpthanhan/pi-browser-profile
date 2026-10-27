# pi-browser-profile

A Pi extension that drives a browser through the bundled `@playwright/cli` (the
same CLI the `pi-playwright` skill uses) **but lets you pin which browser and
which user profile it launches with**.

## Why

`pi-playwright` always opens a fresh, isolated, throwaway profile with bundled
Chromium — it never passes `--profile` / `--persistent`, so a profile you set up
before (logins, cookies, extensions) is never used. This extension injects
`--browser`, `--profile`/`--persistent` (and optionally a specific
`--profile-directory`) on every `open`, and keeps one browser alive per session.

## Install

```bash
pi install git:github.com/tpthanhan/pi-browser-profile
```

This declares `pi-playwright` as a dependency, so installing this package also
installs `pi-playwright` (and its bundled `@playwright/cli`) and loads the
`pi-playwright` skill alongside this extension's `browser` tool and
`/browser-profile` command. One install, everything you need.

If browsers aren't present yet (only needed for the bundled `chromium`; the
`chrome` channel uses your installed Google Chrome), run once:

```bash
npx playwright install chromium
```

### Local development

```bash
pi --extension C:/Personal/pi-browser-profile/index.ts
```

## Where settings are saved

Your editable settings live at a **stable user location** so they survive package
reinstalls/updates:

```
~/.pi/agent/pi-browser-profile.json
```

(on this machine: `C:\Users\921747\.pi\agent\pi-browser-profile.json`)

The `config.json` shipped in this repo is only used as **seed defaults** the first
time, before a user config exists. The `/browser-profile` command writes to the
user location above. Override the path with the `PI_BROWSER_PROFILE_CONFIG`
environment variable. Run `/browser-profile` to see the active path.

## Configure

Set values from inside Pi (written to `~/.pi/agent/pi-browser-profile.json`):

```
/browser-profile                      # show current config
/browser-profile set browser chrome   # chromium | chrome | msedge | firefox | webkit
/browser-profile set profileName playwright   # use a Chrome/Edge profile by its display name
/browser-profile set profile C:/Users/you/pi-chrome-profile
/browser-profile set profileDirectory "Profile 1"   # optional sub-profile (folder name)
/browser-profile set persistent true
/browser-profile set headed true
/browser-profile set session pi-profile
```

### Use an existing Chrome/Edge profile by name (easiest)

If you already created a profile in Chrome (e.g. named **"playwright"**), just
set `profileName` — the extension finds the right user-data-dir and folder for
you by reading the browser's `Local State`:

```
/browser-profile set browser chrome
/browser-profile set profileName playwright
```

It resolves the display name to the real folder (e.g. `Profile 3`) automatically.
You can also pass the folder name itself (`Profile 3`) to `profileName`.

> **Important:** Launching a real Chrome/Edge profile requires that browser to be
> **fully closed** first (all windows). Chrome locks its user-data-dir, so if it's
> running the launch fails. For a profile you use all day, prefer a dedicated
> user-data-dir (see below) so you never have to close your main browser.

| Key                | Meaning                                                                |
|--------------------|------------------------------------------------------------------------|
| `browser`          | Which browser/channel to launch.                                       |
| `profileName`      | Chrome/Edge profile by DISPLAY name (e.g. `playwright`). Auto-resolves user-data-dir + folder. Overrides the two below. |
| `profile`          | Absolute path to a user-data-dir. Empty = managed persistent dir.      |
| `profileDirectory` | Specific profile subfolder (e.g. `Default`, `Profile 1`). Optional.    |
| `persistent`       | Keep profile on disk between runs (auto when `profile` is set).        |
| `headed`           | Launch visibly (recommended when reusing a real profile).              |
| `session`          | playwright-cli session name — one browser per name.                    |
| `playwrightCliEntry` | Override path to `playwright-cli.js`. Empty = auto-detect.            |

### Recommended setup (dedicated profile)

Chrome refuses to launch a user-data-dir that your everyday Chrome already has
open (SingletonLock). So point `profile` at a **dedicated** directory, launch it
once headed, log in, and it's reused forever after:

```
/browser-profile set browser chrome
/browser-profile set profile C:/Users/you/pi-chrome-profile
/browser-profile set headed true
```

Then ask the agent to open a page; sign in once in the window that appears.

## Use (the agent calls the `browser` tool)

```
browser  command=open   args=["https://example.com"]
browser  command=snapshot args=["--filename","C:/tmp/snap.md"]
browser  command=click  args=["e5"]
browser  command=fill   args=["e4","hello@example.com"]
browser  command=eval   args=["() => document.title"]
browser  command=close
```

`open` injects the configured browser/profile/headed automatically. Large output
(snapshot, screenshot, pdf) should go to a file via `--filename`.

## Notes / limitations

- Uses the `@playwright/cli` already installed with `pi-playwright`. If it can't
  be found, set `playwrightCliEntry` in `config.json`.
- A specific `profileDirectory` is applied via a generated one-off cli config
  file carrying `--profile-directory`.
- Close the everyday browser using the same profile before launching, or use a
  dedicated profile dir, to avoid lock conflicts.
