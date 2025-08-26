# link-lib — Smart `npm link` helper

A tiny Node script that **links a local library into your app** the right way—idempotently, Windows-safe, and without clobbering your version spec when you unlink.

- Works with **ESM projects** (`"type": "module"`).
- Detects whether the **global link** and/or the **app link** already exist.
- Replaces a normal installed copy with a **symlink** (after safely removing the folder).
- `--unlink` restores the **exact version spec** you had in `package.json` (e.g. `0.5.0-nightly.5`), instead of jumping to `latest`.
- Optional `--watch` starts your library’s build watcher.

---

## Requirements

- Node 16+ (tested on Node 24)
- npm 8+ (tested with npm 10)
- Windows, macOS, or Linux
- If you’re on Windows, enable **Developer Mode** or run your terminal as **Administrator** so symlinks work.

---

## Install

Add the script (ESM) to your app as `link-lib.js` and install `semver`:

```bash
npm i -D semver
```

(If you already have semver somewhere in the repo, you can skip installing it again.)

Optional: add handy npm scripts to your app’s package.json:

```json
{
  "scripts": {
    "link:lib": "node link-lib.js ../library",
    "link:lib:watch": "node link-lib.js ../library --watch",
    "unlink:lib": "node link-lib.js ../library --unlink",
    "unlink:lib:all": "node link-lib.js ../library --unlink --unlink-global"
  }
}
```

Replace ../library with the relative path from your app to your library.

## What it does

- Detects status
- Creates/refreshes the global link
- Links into the app
- Warns about peerDependencies

## TODOs

- Add package.json
- Add tests
- Improve experience
  - Enable multiple links at the same time with select/click to link/unlink
- publish as npm package
