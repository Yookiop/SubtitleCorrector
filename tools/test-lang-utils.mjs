/*
 * SubtitleCorrector - tests draaien met Node (geen extra pakketten nodig).
 *
 *     node tools/test-lang-utils.mjs
 *
 * Zonder Node kun je exact dezelfde tests in de browser draaien:
 *     dubbelklik tools/test-lang-utils.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

new Function(fs.readFileSync(path.join(root, 'extension', 'src', 'shared', 'lang-utils.js'), 'utf8'))();
new Function(fs.readFileSync(path.join(here, 'lang-utils-tests.js'), 'utf8'))();

const results = globalThis.SCTests.run();
let failed = 0;

for (const r of results) {
  if (r.ok) {
    console.log('  ok   ' + r.name);
  } else {
    failed++;
    console.log(' FAIL  ' + r.name + '\n        ' + r.error);
  }
}

console.log('');
console.log(`${results.length - failed}/${results.length} geslaagd${failed ? ' - GEFAALD' : ' - alles goed'}`);
process.exit(failed ? 1 : 0);
