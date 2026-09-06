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

// Regression: naming a file explicitly must scan it, even under test/. The
// directory filter that hides fixtures was also hiding files the user asked
// for by name, so `winbreak test/thing.js` gave a clean bill of health on a
// file full of bugs — and exited 0 while doing it.
console.log("\nan explicit file argument beats the test-file filter");
const { scan } = require("../lib/scan");
const fs = require("fs");
const direct = scan(path.join(__dirname, "fixtures", "broken.js"));
ok(direct.findings.length > 0,
  `named fixture is scanned (${direct.findings.length} findings)`);
const walked = scan(path.join(__dirname, "fixtures"));
ok(walked.findings.length === 0,
  `walking a test directory still skips it (${walked.findings.length} findings)`);

// Regression: a platform guard can sit ~90 lines above the call it protects,
// in the `if` half of an if/else. winbreak reported nodemon's correct POSIX-only
// kill path as two bugs, and that claim went into the README as fact before I
// re-read it. Guard detection walks enclosing braces now, and follows an `else`
// back to its `if`.
console.log("\nguarded.js — a distant platform guard must suppress");
const guarded = scanFile(path.join(__dirname, "fixtures", "guarded.js"));
const guardedBugs = guarded.filter((f) => f.severity !== "smell");
ok(guardedBugs.length === 0,
  `0 bugs in correctly guarded code (got ${guardedBugs.length}: ` +
  `${guardedBugs.map((f) => f.rule + "@" + f.line).join(", ")})`);

// The other half of the same trade. The first fix for the above was a flat
// 90-line look-back, which suppressed a genuine `rm -rf` in Coinbase's awal
// because the same FILE mentioned win32 in a different function. Precision in
// one direction must not cost recall in the other.
console.log("\nunguarded-mixed.js — win32 elsewhere in the file must NOT suppress");
const mixed = scanFile(path.join(__dirname, "fixtures", "unguarded-mixed.js"));
ok(mixed.some((f) => f.rule === "case-sensitive-rm"),
  `the unguarded rm -rf still fires (${mixed.length} findings)`);

// Regression: `dist/` is generated output in a source repo, but it is the
// entire product in a package downloaded from npm. Skipping it silently
// reported "1 bug in 2 files" for a 43-file package — a clean bill of health
// on unscanned code, which is the exact failure mode this tool complains about.
console.log("\nskipped build output is reported, not hidden");
// Built outside test/ on purpose: anything under a "fixtures" segment is
// hidden by the test-file filter, which would make this test pass for the
// wrong reason.
const os = require("os");
const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), "winbreak-pkg-"));
fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = 1;\n");
fs.copyFileSync(path.join(__dirname, "fixtures", "unguarded-mixed.js"),
  path.join(pkgDir, "dist", "serverManager.js"));
const skipRun = scan(pkgDir);
ok(skipRun.skippedBuild.files === 1,
  `counts the skipped file (got ${skipRun.skippedBuild.files})`);
ok(skipRun.skippedBuild.dirs.includes("dist"), "names dist/ as skipped");
const buildRun = scan(pkgDir, { includeBuild: true });
ok(buildRun.findings.some((f) => f.rule === "case-sensitive-rm"),
  "--include-build finds the bug inside dist/");
fs.rmSync(pkgDir, { recursive: true, force: true });

// The web checker at opusmill.com/check inlines lib/rules.js and lib/core.js
// verbatim. If someone edits a rule and forgets to rebuild, the site starts
// disagreeing with the CLI about a user's code, silently. Fail the build
// instead. Regenerate with `npm run build:web`.
console.log("\nthe web bundle is not stale");
const { buildSource, OUT } = require("../scripts/build-web");
// Compare with line endings normalised. Git checks this file out as CRLF on
// Windows and LF elsewhere, so a byte comparison fails on the Windows CI job
// while nothing is actually wrong -- which is, with some irony, exactly the
// class of bug this tool exists to find.
const normalise = (t) => t.split("\r\n").join("\n");
let bundleCurrent = false;
try {
  bundleCurrent = normalise(fs.readFileSync(OUT, "utf8")) === normalise(buildSource());
} catch { /* missing file counts as stale */ }
ok(bundleCurrent, "web/winbreak.bundle.js matches lib/ (run: npm run build:web)");

// It also has to actually run outside Node's module system, which is the one
// thing a require()-based test would never catch.
console.log("\nthe web bundle runs standalone");
const sandbox = {};
new Function("window", fs.readFileSync(OUT, "utf8"))(sandbox);
ok(!!sandbox.winbreak, "it defines window.winbreak");
ok(sandbox.winbreak && sandbox.winbreak.rules.length === require("../lib/rules").rules.length,
  "it exposes every rule");
const webHits = sandbox.winbreak
  ? sandbox.winbreak.scanSource('spawn("electron.cmd", [a], { stdio: "inherit" });', "d.js")
  : [];
ok(webHits.some((f) => f.rule === "spawn-cmd-no-shell"),
  "it finds the same bug the CLI finds");

// The fixtures are never executed, so a broken escape in one would go
// unnoticed — in a tool that reads other people's JavaScript for a living.
console.log("\nevery fixture is valid JavaScript");
const { execFileSync } = require("child_process");
for (const name of fs.readdirSync(path.join(__dirname, "fixtures"))) {
  const f = path.join(__dirname, "fixtures", name);
  let good = true;
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
  catch { good = false; }
  ok(good, name);
}

console.log(`\n${failed === 0 ? "all green" : failed + " failing"}\n`);
process.exit(failed === 0 ? 0 : 1);
