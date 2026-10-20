/**
 * Folds the Vite build into ONE index.html.
 *
 * No separate asset requests, so the console runs from file://, from a USB
 * stick, and from any GitHub Pages path without a base-href argument. This is
 * the file to put at the root of the Pages repo.
 *
 *   node tools/inline.mjs apps/web/dist out/index.html
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [dist, out] = process.argv.slice(2);
if (!dist || !out) {
  console.error('usage: node tools/inline.mjs <dist dir> <output html>');
  process.exit(2);
}

let html = readFileSync(join(dist, 'index.html'), 'utf8');
const dir = join(dist, 'assets');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const f of readdirSync(dir)) {
  const body = readFileSync(join(dir, f), 'utf8');
  const css = f.endsWith('.css');
  if (!css && !f.endsWith('.js')) continue;
  const tag = css
    ? new RegExp(`<link[^>]*assets/${esc(f)}[^>]*>`)
    : new RegExp(`<script[^>]*assets/${esc(f)}[^>]*></script>`);
  // Replace with a FUNCTION, never a string. A minified bundle is full of
  // `$&` and `$\`` sequences, and String.replace reads those as
  // backreferences, which silently mangles or drops the insertion.
  html = html.replace(tag, () =>
    (css ? `<style>\n${body}\n</style>` : `<script type="module">\n${body}\n</script>`));
}

// The dev page carries a "wrong file" notice inside #root so that publishing
// it by mistake explains itself instead of going blank. In the real build
// that notice would be a lie, and the app mounts into an empty root anyway.
// Anchored on </body> because Vite hoists the script tag into <head>.
html = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<div id="root">[\s\S]*?<\/div>\s*<\/body>/, '<div id="root"></div>\n  </body>');
if (/This is the development page/.test(html)) {
  throw new Error('the development notice survived into the build');
}

const left = [...html.matchAll(/assets\/[^"'\s)]+/g)].map((m) => m[0]);
if (left.length) throw new Error(`asset reference survived inlining: ${left.join(', ')}`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${out}  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
