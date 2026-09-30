# Deploying the Phase 1 proof of concept

This deploys to a **private, free `workers.dev` test address** —
nothing here is wired to `suite.checkdesignz.com` or any customer-
facing domain. You're the only one who'll see the URL unless you share
it.

## One-time setup

```
npm install -g wrangler      # if you don't already have it
wrangler login                # opens a browser to authorize your Cloudflare account
```

## Deploy

From the repo root:

```
wrangler deploy
```

Wrangler will print the live URL, something like:

```
https://seamlessly-creative-suite.<your-subdomain>.workers.dev
```

That's it — this is a pure static deployment (same shape as Mock-up
Studio's own `wrangler.toml`: an `[assets]` block, no worker script, no
bindings), so there's nothing else to configure for Phase 1.

Re-run `wrangler deploy` any time you pull a new commit to push an
update to that same test URL.

## Testing the proof-of-concept flow

1. Open the test URL. You'll land on an empty state — click **Create a
   project** and name it `Café Latte Collection` (or accept the
   suggested name).
2. You're now on the **Pattern Playground** tab, loaded inside the
   suite. Build or open a few patterns as normal, then star (★) a
   handful into the portfolio.
3. A purple bar appears at the top of the Playground pane —
   **"Send starred items to project."** Click it. Watch it count up
   and finish with **"✓ N sent to project."**
4. Click the **Mock-up Studio** tab along the top. A new panel titled
   **"Seamlessly Creative project"** appears above the usual pattern-
   collection strip, showing thumbnails of what you just sent.
5. Tap a thumbnail — it's added to Mock-up Studio's own pattern
   collection exactly as if you'd uploaded it by hand (a green border
   confirms it landed).
6. **Reload the whole page.** The project, its assets, and what you
   added to Mock-up Studio should all still be there — everything
   lives in the browser's IndexedDB, not in memory.
7. Try the **Download Project Backup** button in the top bar — it
   should download one `.screativeproject` file containing every asset
   in the project.
8. Once basic transfer works, stress-test it: build ~25 patterns in
   Playground at your normal working size, star them all, send, then
   add all 25 into Mock-up Studio on an actual iPad in Safari. Watch
   for slowdowns or memory warnings — that's the real target
   environment this was designed for.

## What this does *not* touch

- Pattern Playground's own `pkmDB` database, `.pplayground` backups,
  and Quick Save — all untouched, exactly as in the standalone app.
- Mock-up Studio's own `mockupStudioDB` database, `.mstudio` backups,
  and autosave — all untouched, exactly as in the standalone app.
- The live, customer-facing deployments of either app. Every file
  under `public/studios/` is a **frozen copy**, pinned to the commit
  named in that folder's own notes below — pulling a new commit into
  either studio's real repo does nothing to this suite until someone
  deliberately re-freezes a copy here.
- Pattern Pages isn't in this suite at all yet — its tab shows as
  "(soon)" and is disabled. That's Phase 2.

## Frozen copies in this repo

- `public/studios/playground/index.html` — Pattern Playground,
  `collectionbuilder` repo, branch `claude/collection-builder-mf0bjk`,
  commit `28f3944`, plus one small addition: a handful of internal
  portfolio functions are exposed on `window` (see the "suite adapter
  hook" comment near the end of that file) so the adapter script can
  read the starred portfolio without duplicating its rendering logic.
  No other line was changed.
- `public/studios/mockup/index.html` — Mock-up Studio,
  `SeamlessStudioMockup` repo, `main`, commit `c7d5242`, byte-for-byte
  unchanged (its pattern-add function was already a plain global, so
  no hook needed).
- `public/studios/resizer/index.html` — Creative Resizer,
  `Creativeresizer-pro-` repo, branch
  `claude/mock-up-functions-index137-12gpqi`, commit `fd9b75d`
  (the Seamless Studio compatibility consolidation — iPad Safari decode
  cap, lazy product canvases, scratch-canvas release, native-size
  repeat-count fix — see that repo's history for the full rationale),
  plus the same additive suite-adapter pattern as the other studios:
  `window.__scGetSelectedResizerExports` (a read-only hook reusing the
  existing download-selection logic) and an `opts.repeatModeHint`
  parameter on `loadImage`/`handlePickedPatternFile` so Pattern
  Playground's Half Brick/Half Drop repeat-safe tile can be loaded
  directly instead of re-detected from the file's aspect ratio. No
  other line was changed from the standalone app.

## Later: pointing `suite.checkdesignz.com` at this

When you're ready to move off the workers.dev test address:

1. In the Cloudflare dashboard, open this Worker
   (**seamlessly-creative-suite**) → **Settings → Domains & Routes**
   → **Add → Custom domain** → enter `suite.checkdesignz.com`.
2. Cloudflare creates the DNS record for you automatically, since
   `checkdesignz.com` is already on your Cloudflare account (the same
   one Pattern Pages' `ppages.checkdesignz.com` uses).
3. That's the only step — nothing in this repo needs to change first.

This is deliberately left undone until you say so.
