"use strict";

/**
 * Two things are tested, and the second matters more than the first:
 *   1. every rule fires on the fixture that contains its bug
 *   2. NO rule fires on the fixture of correct code
 *
 * A checker that reports false positives gets uninstalled after one run, so
 * clean.js is the test that actually protects the product.
 */

const path = require("path");
const { scanFile } = require("../lib/scan");
const { rules } = require("../lib/rules");

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failed++;
};

console.log("\nbroken.js — every rule should fire");
const broken = scanFile(path.join(__dirname, "fixtures", "broken.js"));
const fired = new Set(broken.map((f) => f.rule));
for (const r of rules) ok(fired.has(r.id), r.id);

console.log("\nclean.js — nothing should fire");
const clean = scanFile(path.join(__dirname, "fixtures", "clean.js"));
ok(clean.length === 0, `0 findings (got ${clean.length})`);
for (const f of clean) {
  console.log(`        unexpected: ${f.rule} at line ${f.line} -> ${f.source}`);
}

// Regression: line offsets were computed as `length + 1` per line, which is
// wrong for CRLF and made every finding drift down the file. Found by running
// winbreak on its own source.
console.log("\ncrlf.js — line numbers must survive CRLF");
const crlf = scanFile(path.join(__dirname, "fixtures", "crlf.js"));
const spawnHit = crlf.find((f) => f.rule === "spawn-cmd-no-shell");
ok(!!spawnHit, "the spawn is found at all");
ok(spawnHit && spawnHit.line === 15,
  `reported at line 15 (got ${spawnHit ? spawnHit.line : "none"})`);

console.log(`\n${failed === 0 ? "all green" : failed + " failing"}\n`);
process.exit(failed === 0 ? 0 : 1);
