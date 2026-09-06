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

console.log("\nevery rule should fire on the fixture that contains its bug");
const broken = scanFile(path.join(__dirname, "fixtures", "broken.js"));
const brokenPkg = scanFile(path.join(__dirname, "fixtures", "pkg-broken", "package.json"));
const fired = new Set([...broken, ...brokenPkg].map((f) => f.rule));
for (const r of rules) ok(fired.has(r.id), r.id);

// The scripts block of a package.json is where the most common Windows bug in
// the ecosystem lives — cross-env does ~25M downloads a week and exists for no
// other reason. Scanning only .js files missed it entirely.
console.log("\npkg-clean/package.json — correct scripts must not fire");
const cleanPkg = scanFile(path.join(__dirname, "fixtures", "pkg-clean", "package.json"));
ok(cleanPkg.length === 0,
  `0 findings in correct scripts (got ${cleanPkg.length}: ` +
  `${cleanPkg.map((f) => f.rule).join(", ")})`);

console.log("\npkg-broken/package.json — right script, right line");
const inlineEnv = brokenPkg.find((f) => f.rule === "npm-script-inline-env");
ok(inlineEnv && /"build"/.test(inlineEnv.source), "names the offending script");
ok(inlineEnv && inlineEnv.line === 6, `points at line 6 (got ${inlineEnv && inlineEnv.line})`);
ok(!brokenPkg.some((f) => /"ok-/.test(f.source)),
  "cross-env, rimraf and $npm_package_* are not reported");

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

// Regression: four false-positive classes found by scanning the 600
// most-downloaded npm CLI packages and then reading every finding by hand.
// Counting was easy; being right about the count was not.
console.log("\nsurvey-regressions.js -- correct code that was reported");
const surveyFile = path.join(__dirname, "fixtures", "survey-regressions.js");
const surveyBugs = scanFile(surveyFile).filter((f) => f.severity !== "smell");
ok(surveyBugs.length === 0,
  `0 bugs in code that is correct (got ${surveyBugs.length}: ` +
  `${surveyBugs.map((f) => f.rule + "@" + f.line).join(", ")})`);

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
  // The package.json fixtures live in their own directories, and `node --check`
  // has nothing to say about JSON.
  if (!/\.[cm]?js$/.test(name) || fs.statSync(f).isDirectory()) continue;
  let good = true;
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
  catch { good = false; }
  ok(good, name);
}


// --fix rewrites somebody else's package.json, which is the most destructive
// thing this tool does. The round-trip test at the end is the one that matters:
// whatever it writes must come back clean when scanned again, or the tool is
// telling the user it fixed something it did not.
console.log("\n--fix: the two transforms with one obvious answer");
const { fixScript, fixPackageJson, applyToText } = require("../lib/fix");

const fx = (cmd) => fixScript(cmd).fixed;
ok(fx("rm -rf dist") === "rimraf dist", "rm -rf -> rimraf");
ok(fx("NODE_ENV=test node --test") === "cross-env NODE_ENV=test node --test",
  "inline env -> cross-env");
ok(fx("rm -rf dist && NODE_ENV=production rollup -c") ===
   "rimraf dist && cross-env NODE_ENV=production rollup -c",
  "both, in one script, keeping the &&");

console.log("\n--fix: leaves alone what it cannot honestly repair");
const untouched = [
  "for FILE in example/*.js; do node $FILE; done",
  "eclint check $(git ls-files | xargs find)",
  "node -e \"x\" | grep foo",
  "sed -i -e 's:a:b:g' README.md",
  "rm -i notes.txt",
];
for (const u of untouched) {
  ok(fixScript(u).fixed === u, `unchanged: ${u.slice(0, 42)}`);
}

console.log("\n--fix: does not undo or double-apply a correct script");
for (const good of ["cross-env NODE_ENV=test jest", "rimraf dist", "eslint ."]) {
  ok(fixScript(good).changed === false, `no change: ${good}`);
}
// Idempotence: running it twice must equal running it once.
const once = fx("rm -rf dist && NODE_ENV=production rollup -c");
ok(fx(once) === once, "applying the fix twice changes nothing the second time");

// Regression: splitting on && without tracking quotes turned
// `echo "a && b" && rm -rf x` into three segments and mangled the echo.
console.log("\n--fix: an operator inside quotes is not a separator");
ok(fx('echo "a && b" && rm -rf x') === 'echo "a && b" && rimraf x',
  "quoted && survives, the real one is still split on");

// The file is a user's package.json. Reserializing it with JSON.stringify
// would reindent every line and drop the trailing newline, turning a two-line
// fix into an unreviewable diff.
console.log("\n--fix: rewrites values without reformatting the file");
const rawPkg =
  '{\n\t"name": "demo",\n\t"scripts": {\n\t\t"build"   :   "rm -rf dist",\n' +
  '\t\t"say": "node -e \\"console.log(1)\\""\n\t}\n}\n';
const parsed = JSON.parse(rawPkg);
const fixResult = fixPackageJson(parsed);
const rewritten = applyToText(rawPkg, fixResult.changes);
ok(rewritten.includes('"build"   :   "rimraf dist"'), "odd spacing is preserved");
ok(rewritten.endsWith("}\n"), "the trailing newline survives");
ok(JSON.parse(rewritten).scripts.say === parsed.scripts.say,
  "a script it did not touch is byte-identical");
let reparsed = null;
try { reparsed = JSON.parse(rewritten); } catch { /* stays null */ }
ok(reparsed !== null, "the result is still valid JSON");
ok(fixResult.needs.includes("rimraf"), "it reports the dependency the fix needs");

// The one that would matter to a user: scan, fix, scan again.
console.log("\n--fix: what it writes comes back clean");
const fixDir = fs.mkdtempSync(path.join(os.tmpdir(), "winbreak-fix-"));
fs.writeFileSync(path.join(fixDir, "package.json"), JSON.stringify({
  name: "roundtrip",
  scripts: {
    clean: "rm -rf dist",
    build: "rm -rf dist && NODE_ENV=production rollup -c",
    test: "cross-env NODE_ENV=test jest",
  },
}, null, 2) + "\n");
const beforeFix = scan(fixDir).findings.filter((f) => /^npm-script-/.test(f.rule));
ok(beforeFix.length === 3, `3 script findings before the fix (got ${beforeFix.length})`);
execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "cli.js"),
  fixDir, "--fix", "--no-exit-code"], { stdio: "pipe" });
const afterFix = scan(fixDir).findings.filter((f) => /^npm-script-/.test(f.rule));
ok(afterFix.length === 0,
  `0 script findings after the fix (got ${afterFix.length}: ` +
  `${afterFix.map((f) => f.rule).join(", ")})`);
let stillJson = false;
try {
  JSON.parse(fs.readFileSync(path.join(fixDir, "package.json"), "utf8"));
  stillJson = true;
} catch { /* stays false */ }
ok(stillJson, "the file it wrote is still valid JSON");
fs.rmSync(fixDir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "all green" : failed + " failing"}\n`);
process.exit(failed === 0 ? 0 : 1);
