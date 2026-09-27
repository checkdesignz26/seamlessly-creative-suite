# Seamlessly Creative — suite

Phase 1 proof of concept for tying Pattern Playground, Creative
Resizer, Pattern Pages and Mock-up Studio together behind one project,
instead of four separate apps.

See [DEPLOY.md](./DEPLOY.md) for how to deploy this and test the
proof-of-concept flow.

## What's here (Phase 1)

- `public/index.html` + `shell.js` + `shell.css` — the suite shell: a
  persistent top bar (project name, save status, studio switcher,
  "Download Project Backup") with the active studio loaded underneath
  it in an iframe.
- `public/shared/project-library.js` — the shared project/asset
  library. One new IndexedDB (`seamlesslyCreativeSuite`), separate
  from every existing studio database. Assets are stored as PNG blobs,
  not base64 text.
- `public/shared/suite-status.js` — a tiny postMessage channel each
  studio adapter uses to report save status up to the shell's one
  indicator.
- `public/shared/adapters/` — one small script per studio:
  - `playground-adapter.js` — **send**: reads Pattern Playground's
    starred portfolio and writes rendered PNGs into the project.
  - `mockup-adapter.js` — **receive**: lists the project's patterns
    and adds a chosen one through Mock-up Studio's own
    `addQuickCollectionPattern`.
- `public/studios/playground/`, `public/studios/mockup/` — **frozen
  copies** of the two studios, pinned to a specific commit each (see
  DEPLOY.md for exactly which). Each has one small, clearly-commented
  addition — never a rewrite — so its adapter can talk to it. Creative
  Resizer and Pattern Pages aren't wired in yet; that's Phase 2.

## What this does NOT touch

Nothing in the standalone, live, deployed apps. Nothing in their
existing databases (`pkmDB`, `mockupStudioDB`, `patternPagesAutoSaveDB`)
or `localStorage`. This is a separate repo, deployed to a separate,
private test address, on its own new database. See DEPLOY.md for the
full guarantee and how it was verified.

## Status

Built and tested end-to-end against the real app code (not mocked) in
a headless browser: create a project, star patterns in Pattern
Playground, send them, switch to Mock-up Studio, add them from the
project, reload the page, confirm everything — the shared project, and
each studio's own save — survived from IndexedDB alone. Not yet
deployed anywhere; see DEPLOY.md.
