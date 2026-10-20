import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * The file that gets published.
 *
 * Twice now a blank page has been deployed, both times because the repository
 * contains two files called index.html — the Vite development page and the
 * built console — and uploading the source folder lets the wrong one win.
 * These are the properties that tell them apart.
 */
const DEV = 'apps/web/index.html';
const BUILT = 'dist/index.html';

describe('the development page', () => {
  const html = readFileSync(DEV, 'utf8');

  it('explains itself rather than going blank if it is ever published', () => {
    expect(html).toMatch(/This is the development page/);
    // The notice has to be INSIDE #root, so the app overwrites it on mount.
    const root = html.slice(html.indexOf('<div id="root">'));
    expect(root).toMatch(/This is the development page/);
  });

  it('says what to upload instead', () => {
    expect(html).toMatch(/build:single/);
    expect(html).toMatch(/dist\/index\.html/);
  });
});

describe('the built console', () => {
  const built = existsSync(BUILT) ? readFileSync(BUILT, 'utf8') : null;

  it.skipIf(!built)('carries no development notice, which would be a lie', () => {
    expect(built!).not.toMatch(/This is the development page/);
    expect(built!).toMatch(/<div id="root"><\/div>/);
  });

  it.skipIf(!built)('is self-contained: no asset requests, no source reference', () => {
    expect(built!).not.toMatch(/assets\//);
    expect(built!).not.toMatch(/src\/main\.tsx/);
  });

  it.skipIf(!built)('is the big one, so size alone tells them apart', () => {
    expect(built!.length).toBeGreaterThan(100_000);
    expect(readFileSync(DEV, 'utf8').length).toBeLessThan(5_000);
  });
});
