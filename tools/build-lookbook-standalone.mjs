#!/usr/bin/env node
/**
 * Builds the Creative Lookbook as a SEPARATE, self-contained static site (no rebuild of any code — it just copies
 * the files the page already uses and rewrites the relative paths):
 *
 *   node tools/build-lookbook-standalone.mjs [outDir]        (default: dist/lookbook-standalone)
 *
 * Deploy the result on its own (e.g. a second Cloudflare Workers/Pages project with its own domain):
 *   cd dist/lookbook-standalone && npx wrangler deploy        (uses the generated wrangler.toml)
 *
 * Contents: index.html, app.js, app.css, shared/{collage-*.js, lookbook/*, vendor/{pdf-lib,jszip}}.
 * Nothing from the suite shell, project library, or any other studio is included.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const out = join(root, process.argv[2] || 'dist/lookbook-standalone');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'shared', 'vendor'), { recursive: true });

for (const f of readdirSync(join(pub, 'shared'))) if (/^collage-.*\.js$/.test(f)) cpSync(join(pub, 'shared', f), join(out, 'shared', f));
cpSync(join(pub, 'shared', 'lookbook'), join(out, 'shared', 'lookbook'), { recursive: true });
for (const f of readdirSync(join(pub, 'shared', 'vendor'))) if (/^(pdf-lib|jszip)/.test(f)) cpSync(join(pub, 'shared', 'vendor', f), join(out, 'shared', 'vendor', f));
cpSync(join(pub, 'studios', 'lookbook', 'app.js'), join(out, 'app.js'));
cpSync(join(pub, 'studios', 'lookbook', 'app.css'), join(out, 'app.css'));

const html = readFileSync(join(pub, 'studios', 'lookbook', 'index.html'), 'utf8').split('../../shared/').join('shared/');
if (html.includes('../../')) throw new Error('unrewritten relative path left in index.html');
writeFileSync(join(out, 'index.html'), html);

writeFileSync(join(out, 'wrangler.toml'), `# Creative Lookbook — standalone deployment (static assets only, like the suite).
name = "creative-lookbook"
compatibility_date = "2024-09-23"

[assets]
directory = "."
`);
console.log('built', out);
