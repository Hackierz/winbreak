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

// The /check page offers a repaired package.json to copy. If an export goes
// missing the panel just never appears -- no error, no sign anything is wrong.
ok(sandbox.winbreak && typeof sandbox.winbreak.fixPackageJson === "function",
  "it exposes fixPackageJson");
ok(sandbox.winbreak && typeof sandbox.winbreak.applyToText === "function",
  "it exposes applyToText");
const webFix = sandbox.winbreak
  ? sandbox.winbreak.fixScript("rm -rf dist && NODE_ENV=x rollup -c").fixed
  : "";
ok(webFix === "rimraf dist && cross-env NODE_ENV=x rollup -c",
  "the browser fix agrees with the CLI fix");

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


// GitHub annotations are the reason anyone leaves this in their CI: a log line
// saying "3 bugs" has to be gone looking for, an annotation on the changed
// line cannot be missed. Every failure mode here is silent -- a bad path or an
// unescaped character produces an annotation attached to nothing, which looks
// exactly like finding less.
console.log("\ngithub: annotations land on the right line of the right file");
const gh = require("../lib/github");
const ghRoot = path.join(__dirname, "..");
const ghFindings = scanFile(path.join(__dirname, "fixtures", "broken.js"));
const ghLines = gh.annotations(ghFindings, ghRoot);

ok(ghLines.length === ghFindings.length, "one annotation per finding");
ok(ghLines.every((l) => /^::(error|warning) /.test(l)),
  "every line is a workflow command");
ok(ghLines.every((l) => !/\r|\n/.test(l)),
  "no raw newline (it would truncate the annotation silently)");

// A path GitHub cannot match to the diff shows in the log and never on the
// file. Backslashes do exactly that, and this suite runs on Windows.
ok(ghLines.every((l) => /file=test\/fixtures\/broken\.js,/.test(l)),
  "the path is repo-relative with forward slashes");
// Only the file= property: the message body legitimately contains a backslash
// (the /tmp rule explains that "/tmp/x" becomes C:\tmp\x on Windows).
ok(ghLines.every((l) => !/file=[^,]*\\/.test(l)),
  "no backslash survives into the file= property");

console.log("\ngithub: workflow-command escaping");
ok(gh.escapeData("a\nb") === "a%0Ab", "newline in a message becomes %0A");
ok(gh.escapeData("100%") === "100%25", "percent is escaped first, not twice");
ok(gh.escapeProp("a:b,c") === "a%3Ab%2Cc",
  "colon and comma are escaped in a property");
ok(gh.escapeData("a:b,c") === "a:b,c",
  "...but not in a message, where they are legal");

console.log("\ngithub: severity maps to the right annotation level");
const ghMixed = [
  { file: path.join(ghRoot, "x.js"), line: 1, rule: "r", title: "t", why: "w", fix: "f", severity: "bug" },
  { file: path.join(ghRoot, "x.js"), line: 2, rule: "r", title: "t", why: "w", fix: "f", severity: "smell" },
];
const ghMixedOut = gh.annotations(ghMixed, ghRoot);
ok(ghMixedOut[0].startsWith("::error "), "a bug is an error");
ok(ghMixedOut[1].startsWith("::warning "), "a smell is only a warning");

console.log("\ngithub: the job summary");
const sumClean = gh.summary({ files: 9, findings: [], skippedBuild: null }, ghRoot, {});
ok(/No Windows-portability problems found in 9 files/.test(sumClean),
  "a clean run says so plainly");
ok(!sumClean.includes("|"), "and draws no empty table");
const sumDirty = gh.summary(
  { files: 3, findings: ghMixed, skippedBuild: { files: 2, dirs: ["dist"] } },
  ghRoot, { fixable: 1 });
ok(/\*\*1 bug\*\* and 1 smell/.test(sumDirty), "it counts bugs and smells apart");
ok(sumDirty.includes("`x.js`"), "it names the file");
ok(/Skipped 2 files in `dist\/`/.test(sumDirty),
  "it still reports skipped build output");
ok(sumDirty.includes("npx winbreak --fix"), "it says how many can be auto-fixed");

// A pipe inside a title would end the markdown cell and shift every column.
const piped = gh.summary({ files: 1, skippedBuild: null, findings: [
  { file: path.join(ghRoot, "y.js"), line: 1, rule: "r", title: "a | b", why: "w", fix: "f", severity: "bug" },
] }, ghRoot, {});
ok(piped.includes("a \\| b"), "a pipe in a title is escaped, not left to break the table");

console.log("\ngithub: --github exits like the rest of the tool");
const cliPath = path.join(__dirname, "..", "bin", "cli.js");
const runGh = (args) => {
  try {
    execFileSync(process.execPath, [cliPath, ...args], { stdio: "pipe" });
    return 0;
  } catch (e) { return e.status; }
};
ok(runGh([path.join(__dirname, "fixtures", "broken.js"), "--github"]) === 1,
  "exit 1 when it finds a bug");
ok(runGh([path.join(__dirname, "..", "lib"), "--github"]) === 0,
  "exit 0 on a clean tree");
ok(runGh([path.join(__dirname, "fixtures", "broken.js"), "--github", "--no-exit-code"]) === 0,
  "--no-exit-code still wins");

// The action is a plain file in the repo; a typo in it fails at use time, in
// somebody else's workflow, with a message about YAML.
console.log("\nthe action manifest is present and consistent");
const actionYml = fs.readFileSync(path.join(ghRoot, "action.yml"), "utf8");
ok(/using:\s*composite/.test(actionYml), "action.yml declares a composite action");
ok(actionYml.includes("bin/cli.js"), "it runs the CLI");
ok(actionYml.includes("--github"), "it asks for annotations");
for (const out of ["findings", "bugs", "smells", "files", "fixable"]) {
  ok(new RegExp("steps\\.winbreak\\.outputs\\." + out).test(actionYml),
    `it wires up the "${out}" output`);
}
// Under `shell: bash` GitHub adds -e, so `[ x = y ] && arg` aborts the step
// whenever the condition is false -- which is the default for every one of
// these flags.
ok(!/^\s*\[.*\]\s*&&/m.test(actionYml),
  "no bare `[ ... ] && ...` line (it would abort the step under -e)");


// The mirror rule: works on Windows and macOS, breaks on Linux. It needs a
// real directory, so the fixture is built on disk rather than in test/fixtures
// -- and it has to be built rather than committed, because git on a
// case-insensitive filesystem is unreliable about files that differ only by
// case, which is the very hazard being tested.
console.log("\nimport-case-mismatch: case that differs from the file on disk");
const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), "winbreak-case-"));
fs.mkdirSync(path.join(caseDir, "Utils"));
fs.writeFileSync(path.join(caseDir, "Foo.js"), "module.exports = 1;\n");
fs.writeFileSync(path.join(caseDir, "exact.js"), "module.exports = 3;\n");
fs.writeFileSync(path.join(caseDir, "Utils", "Helper.js"), "module.exports = 2;\n");
const caseMain = path.join(caseDir, "main.js");
fs.writeFileSync(caseMain, [
  'const a = require("./foo");',            // 1  wrong: Foo.js
  'const b = require("./Foo");',            // 2  right
  'const c = require("./utils/Helper");',   // 3  wrong directory: Utils
  'const d = require("./Utils/helper");',   // 4  wrong file: Helper.js
  'const e = require("./exact");',          // 5  right
  'const f = require("./nope-not-here");',  // 6  missing, not a case bug
  'import g from "./foo.js";',              // 7  wrong, with extension
  'export { h } from "./Utils/Helper";',    // 8  right
  'const i = require("fs");',               // 9  builtin
  'const j = require("lodash/Map");',       // 10 bare specifier, not ours
].join("\n") + "\n");

const caseHits = scanFile(caseMain).filter((f) => f.rule === "import-case-mismatch");
const caseLines = caseHits.map((f) => f.line).sort((x, y) => x - y);
ok(caseLines.join(",") === "1,3,4,7",
  `flags exactly lines 1,3,4,7 (got ${caseLines.join(",") || "none"})`);
ok(caseHits.some((f) => /"Foo\.js"/.test(f.fix)),
  "the fix names the real filename");
ok(caseHits.some((f) => /directory on disk is "Utils"/.test(f.why)),
  "a wrong directory is reported as a directory");

// Regression: the pattern starts with (?:^|[\s;}]) so `import` is a whole
// word, and that leading character is usually the PREVIOUS line's newline.
// Anchoring on m.index reported every `import ... from` finding one line early.
const importHit = caseHits.find((f) => /^import /.test(f.source));
ok(importHit && importHit.line === 7,
  `the import-from finding is on its own line, 7 (got ${importHit && importHit.line})`);

// A missing module is somebody else's error. Reporting it as a case problem
// would send the reader looking for a spelling difference that is not there.
ok(!caseHits.some((f) => /nope-not-here/.test(f.source)),
  "an import that matches nothing is not reported");
ok(!caseHits.some((f) => /lodash/.test(f.source)),
  "a bare package specifier is not reported");

console.log("\nimport-case-mismatch: CRLF must not shift the line numbers");
const caseCrlf = path.join(caseDir, "crlf.js");
fs.writeFileSync(caseCrlf,
  fs.readFileSync(caseMain, "utf8").split("\n").join("\r\n"));
const crlfLines = scanFile(caseCrlf)
  .filter((f) => f.rule === "import-case-mismatch")
  .map((f) => f.line).sort((x, y) => x - y);
ok(crlfLines.join(",") === "1,3,4,7",
  `same lines under CRLF (got ${crlfLines.join(",") || "none"})`);

console.log("\nimport-case-mismatch: correct code stays silent");
const caseClean = path.join(caseDir, "clean.js");
fs.writeFileSync(caseClean, [
  'const a = require("./Foo");',
  'const b = require("./Utils/Helper");',
  'const c = require("./exact.js");',
  'import d from "./Foo.js";',
  'export { e } from "./Utils/Helper.js";',
].join("\n") + "\n");
const cleanCase = scanFile(caseClean).filter((f) => f.rule === "import-case-mismatch");
ok(cleanCase.length === 0,
  `0 findings on correctly-cased imports (got ${cleanCase.length})`);
fs.rmSync(caseDir, { recursive: true, force: true });

// It reads directories, so a path it cannot read must not take the scan down.
console.log("\nimport-case-mismatch: an unreadable directory is survivable");
const { scanImports } = require("../lib/casecheck");
let survived = true;
try {
  scanImports('require("./x");', path.join("Z:", "no", "such", "place", "a.js"));
} catch (e) { survived = false; }
ok(survived, "scanning against a non-existent directory does not throw");


console.log("\n--fix: cp / mv / mkdir -p via shx");
ok(fx("cp -R ./src/assets ./lib/") === "shx cp -R ./src/assets ./lib/",
  "cp -R -> shx cp -R");
ok(fx("mkdir -p coverage && bun test") === "shx mkdir -p coverage && bun test",
  "mkdir -p -> shx mkdir -p, leaving the rest alone");
ok(fx("mv a b") === "shx mv a b", "mv -> shx mv");
// shx globs internally, so `cp es6/*.ts js` does not need a shell to expand
// the pattern first. Verified from cmd.exe: it copied the .ts files and not
// the .js one.
ok(fx("cp es6/*.ts js") === "shx cp es6/*.ts js",
  "a glob is left for shx to expand, not the shell");

console.log("\n--fix: flags shx does not implement are refused, by name");
const parents = fixScript("cp --parents a b");
ok(parents.changed === false, "cp --parents is not rewritten");
ok(parents.skipped.some((k) => /--parents/.test(k.why)),
  "and the refusal names the flag");

console.log("\n--fix: commands deliberately left out of the shx table");
// shx has ln, but a symlink on Windows needs elevation or developer mode, so
// the "fix" would fail on exactly the machines that need it.
ok(fixScript("ln -s a b").changed === false, "ln -s is not rewritten");
ok(fixScript("chmod +x bin/cli.js").changed === false, "chmod is not rewritten");

console.log("\n--fix: shx does not collide with the other two transforms");
ok(fx("rm -rf dist && cp a b") === "rimraf dist && shx cp a b",
  "rimraf and shx in one script");
ok(fx("mkdir -p a && NODE_ENV=x node b.js") ===
   "shx mkdir -p a && cross-env NODE_ENV=x node b.js",
  "shx and cross-env in one script");
ok(fixScript("shx cp a b").changed === false,
  "an already-fixed shx command is left alone");
// `mkdirp` is a package, `mkdir` is the command. Matching the prefix would
// rewrite a script that was already correct.
ok(fixScript("mkdirp js").changed === false,
  "mkdirp the package is not mistaken for mkdir the command");
const shxOnce = fx("cp -R src dest");
ok(fx(shxOnce) === shxOnce, "applying the shx fix twice changes nothing");

const shxNeeds = fixScript("cp a b && mkdir -p c");
ok(shxNeeds.needs.length === 1 && shxNeeds.needs[0] === "shx",
  "shx is reported once, not per command");


// Not a test of winbreak -- a test of the platform, printed so CI records what
// each OS actually does. The import-case-mismatch rule exists because these
// three lines disagree across platforms, and it is better to have the runners
// state that than to quote it from memory.
console.log("\nwhat this platform does with a mis-cased require (for the record)");
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "winbreak-probe-"));
fs.writeFileSync(path.join(probeDir, "Foo.js"), "module.exports = 'loaded';\n");

const insensitiveExists = fs.existsSync(path.join(probeDir, "foo.js"));
let requireResult;
try {
  requireResult = require(path.join(probeDir, "foo"));
} catch (e) {
  requireResult = e.code || "threw";
}
const realEntries = fs.readdirSync(probeDir);

console.log(`        platform                : ${process.platform}`);
console.log(`        readdirSync             : ${JSON.stringify(realEntries)}`);
console.log(`        existsSync("foo.js")    : ${insensitiveExists}`);
console.log(`        require("./foo")        : ${requireResult}`);

// The two behaviours are the two halves of the bug, and exactly one must hold.
const caseInsensitive = insensitiveExists && requireResult === "loaded";
const caseSensitive = !insensitiveExists && requireResult === "MODULE_NOT_FOUND";
ok(caseInsensitive || caseSensitive,
  caseInsensitive
    ? "case-insensitive filesystem: existsSync lies and require succeeds"
    : "case-sensitive filesystem: existsSync is honest and require throws MODULE_NOT_FOUND");
fs.rmSync(probeDir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "all green" : failed + " failing"}\n`);
process.exit(failed === 0 ? 0 : 1);
