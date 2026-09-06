#!/usr/bin/env node
"use strict";

const path = require("path");
const { scan } = require("../lib/scan");
const { rules } = require("../lib/rules");

const args = process.argv.slice(2);

function usage() {
  console.log(`
winbreak — find the code that works on your Mac and breaks on Windows

  npx winbreak [path]        scan a directory or file (default: .)

Options
  --fix                      repair the npm scripts that have one obvious fix
  --dry-run                  with --fix: show the changes, write nothing
  --github                   annotate the pull request diff (GitHub Actions)
  --json                     machine-readable output
  --quiet                    only the summary line
  --rules                    list the rules and exit
  --strict                   also fail the build on smells, not just bugs
  --include-tests            also scan test files (skipped by default)
  --include-build            also scan dist/ build/ out/ (skipped by default)
  --no-exit-code             always exit 0, even with findings
  -h, --help                 this

--fix only ever touches the "scripts" block of a package.json, and only the
two problems with a single agreed answer: inline environment variables become
cross-env, and rm -rf becomes rimraf. Shell loops, $(...) and pipelines are
reported and left alone -- they need a real script file, not a substitution.

Ignore a line by putting  winbreak-ignore  in a comment on it,
or  winbreak-ignore-next  on the line above.
`);
}

if (args.includes("-h") || args.includes("--help")) { usage(); process.exit(0); }

if (args.includes("--rules")) {
  for (const r of rules) {
    console.log(`\n${r.id}\n  ${r.title}\n  why: ${r.why}\n  fix: ${r.fix}`);
  }
  process.exit(0);
}

const json = args.includes("--json");
const quiet = args.includes("--quiet");
const noExit = args.includes("--no-exit-code");
const strict = args.includes("--strict");
const target = args.find((a) => !a.startsWith("-")) || ".";

let result;
try {
  result = scan(path.resolve(target), {
    includeTests: args.includes("--include-tests"),
    includeBuild: args.includes("--include-build"),
  });
} catch (e) {
  console.error(`winbreak: cannot read ${target} — ${e.message}`);
  process.exit(2);
}

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const red = (s) => c(31, s);
const yellow = (s) => c(33, s);
const green = (s) => c(32, s);
const cyan = (s) => c(36, s);

if (args.includes("--fix")) {
  const fs = require("fs");
  const { fixPackageJson, applyToText, NEEDS } = require("../lib/fix");
  const dry = args.includes("--dry-run");

  // Only files the scan actually reported a script problem in. Rewriting a
  // package.json winbreak has nothing to say about would be an edit the user
  // did not ask for.
  const SCRIPT_RULES = new Set([
    "npm-script-inline-env", "npm-script-posix-command", "npm-script-shell-var",
  ]);
  const targets = [...new Set(
    result.findings.filter((f) => SCRIPT_RULES.has(f.rule)).map((f) => f.file)
  )];

  if (!targets.length) {
    console.log(green("\u2713 no npm script needs fixing"));
    process.exit(0);
  }

  let written = 0;
  const needs = new Set();
  const leftAlone = [];

  // path.relative climbs out with ../../.. when the target is not under the
  // working directory, which is longer and harder to read than the real path.
  const show = (f) => {
    const rel = path.relative(process.cwd(), f);
    return rel && rel.length < f.length && !rel.startsWith("..") ? rel : f;
  };

  for (const file of targets) {
    const rel = show(file);
    let src;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch (e) {
      console.error(red(`cannot read ${rel} \u2014 ${e.message}`));
      process.exitCode = 2;
      continue;
    }

    let pkg;
    try {
      pkg = JSON.parse(src);
    } catch (e) {
      console.error(red(`${rel} is not valid JSON \u2014 ${e.message}`));
      process.exitCode = 2;
      continue;
    }

    const r = fixPackageJson(pkg);
    for (const n of r.needs) needs.add(n);
    for (const sk of r.skipped) leftAlone.push({ file: rel, ...sk });

    if (!r.changes.length) continue;

    console.log(`\n${bold(rel)}`);
    for (const ch of r.changes) {
      console.log(`  ${bold(JSON.stringify(ch.script))}`);
      console.log(`    ${red("-")} ${ch.before}`);
      console.log(`    ${green("+")} ${ch.after}`);
    }

    if (dry) continue;

    let out;
    try {
      // Rewrites only the changed values, so the diff a reviewer sees is the
      // two lines that changed and not a reformat of the whole file.
      out = applyToText(src, r.changes);
      JSON.parse(out); // never write a package.json we just broke
    } catch (e) {
      console.error(red(`  refused to write ${rel} \u2014 ${e.message}`));
      process.exitCode = 2;
      continue;
    }
    fs.writeFileSync(file, out);
    written++;
  }

  if (leftAlone.length) {
    console.log(`\n${yellow("left alone, because these need a real script file:")}`);
    for (const l of leftAlone.slice(0, 12)) {
      console.log(`  ${dim(l.file)}  ${bold(JSON.stringify(l.script))}  ${dim("(" + l.why + ")")}`);
      console.log(`    ${dim(l.text.length > 96 ? l.text.slice(0, 93) + "..." : l.text)}`);
    }
    if (leftAlone.length > 12) {
      console.log(dim(`  ...and ${leftAlone.length - 12} more`));
    }
    console.log(dim("  move these into a .mjs file and call it with node \u2014 that runs anywhere"));
  }

  // Findings that were neither fixed nor explicitly refused would otherwise
  // disappear from this report entirely, and "rewrote 2 files" would read as
  // "done". Re-scan and say plainly what is left.
  if (!dry) {
    let remaining = 0;
    try {
      remaining = scan(path.resolve(target), {
        includeTests: args.includes("--include-tests"),
        includeBuild: args.includes("--include-build"),
      }).findings.filter((f) => SCRIPT_RULES.has(f.rule)).length;
    } catch (e) { remaining = -1; }
    if (remaining > 0) {
      console.log(`
${yellow(`${remaining} npm script finding${remaining === 1 ? "" : "s"} still need${remaining === 1 ? "s" : ""} a human`)}`);
      console.log(dim("  run winbreak again without --fix to see them in full"));
    }
  }

  console.log();
  if (dry) {
    console.log(dim("--dry-run: nothing was written"));
  } else if (written) {
    console.log(green(`\u2713 rewrote ${written} package.json file${written === 1 ? "" : "s"}`));
  } else {
    console.log(dim("nothing was rewritten"));
  }

  if (needs.size) {
    console.log(`\n${bold("these fixes need:")}`);
    for (const n of needs) console.log(`  ${cyan(n)}  ${dim(NEEDS[n] || "")}`);
    console.log(`\n  ${bold("npm install --save-dev " + [...needs].join(" "))}`);
    console.log(dim("  not run for you \u2014 installing into someone's project is their call"));
  }
  process.exit(process.exitCode || 0);
}

if (args.includes("--github")) {
  const fs = require("fs");
  const gh = require("../lib/github");
  const root = process.env.GITHUB_WORKSPACE || process.cwd();

  for (const line of gh.annotations(result.findings, root)) console.log(line);

  // How many the user could fix without reading anything, which is the most
  // actionable number in the summary.
  let fixable = 0;
  try {
    const { fixScript } = require("../lib/fix");
    for (const f of result.findings) {
      if (!/^npm-script-/.test(f.rule)) continue;
      const m = /^"[^"]*"\s*:\s*("(?:[^"\\]|\\.)*")\s*$/.exec(f.source || "");
      if (!m) continue;
      let cmd = null;
      try { cmd = JSON.parse(m[1]); } catch (e) { cmd = null; }
      if (cmd !== null && fixScript(cmd).changed) fixable++;
    }
  } catch (e) { fixable = 0; }

  const md = gh.summary(result, root, { fixable });
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
    } catch (e) {
      // A summary that cannot be written is not worth failing a build over,
      // but staying silent about it would hide a broken action.
      console.log(`::warning::winbreak could not write the job summary - ${e.message}`);
    }
  } else {
    // Run locally, so there is nowhere to put it but the terminal.
    console.log("\n" + md);
  }

  const ghBugs = result.findings.filter((f) => f.severity !== "smell").length;

  // So a workflow can branch on the result without re-parsing the log.
  if (process.env.GITHUB_OUTPUT) {
    try {
      fs.appendFileSync(process.env.GITHUB_OUTPUT,
        `findings=${result.findings.length}
` +
        `bugs=${ghBugs}
` +
        `smells=${result.findings.length - ghBugs}
` +
        `files=${result.files}
` +
        `fixable=${fixable}
`);
    } catch (e) {
      console.log(`::warning::winbreak could not write step outputs - ${e.message}`);
    }
  }

  process.exit(noExit || (strict ? result.findings.length : ghBugs) === 0 ? 0 : 1);
}

if (json) {
  console.log(JSON.stringify(
    {
      scanned: result.files,
      skippedBuild: result.skippedBuild,
      count: result.findings.length,
      findings: result.findings,
    },
    null, 2));
  const jsonBugs = result.findings.filter((f) => f.severity !== "smell").length;
  process.exit(noExit || (strict ? result.findings.length : jsonBugs) === 0 ? 0 : 1);
}

if (!quiet) {
  const byFile = new Map();
  for (const f of result.findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  for (const [file, list] of byFile) {
    console.log(`\n${bold(path.relative(process.cwd(), file) || file)}`);
    for (const f of list) {
      const tag = f.severity === "smell" ? yellow("smell") : red("bug  ");
      console.log(`  ${dim(String(f.line).padStart(5))}  ${tag}  ${bold(f.title)}  ${dim(f.rule)}`);
      if (f.source) console.log(`         ${dim(f.source)}`);
      console.log(`         ${dim("why:")} ${f.why}`);
      console.log(`         ${cyan("fix:")} ${f.fix}`);
    }
  }
}

const bugs = result.findings.filter((f) => f.severity !== "smell").length;
const smells = result.findings.length - bugs;
const n = result.findings.length;

console.log();
if (n === 0) {
  console.log(green(`✓ nothing found — scanned ${result.files} file${result.files === 1 ? "" : "s"}`));
} else {
  const parts = [];
  if (bugs) parts.push(red(`${bugs} bug${bugs === 1 ? "" : "s"}`));
  if (smells) parts.push(yellow(`${smells} smell${smells === 1 ? "" : "s"}`));
  console.log(`${parts.join(" and ")} in ${result.files} file${result.files === 1 ? "" : "s"}`);
  console.log(dim("these are heuristics — read each one before you change anything"));
  if (smells && !bugs && !strict) {
    console.log(dim("smells do not fail the build; use --strict if you want them to"));
  }
}

// Never let a skipped directory pass for a clean bill of health. On a package
// downloaded from npm, dist/ IS the shipped code, and staying quiet about it
// would be the same silent failure this tool was written to catch.
const sb = result.skippedBuild;
if (sb && sb.files > 0) {
  console.log(dim(
    `note: skipped ${sb.files} file${sb.files === 1 ? "" : "s"} in ` +
    `${sb.dirs.map((d) => d + "/").join(", ")} — ` +
    `rerun with --include-build to scan build output`));
}

// A smell is a judgement call about style. Failing someone's pipeline over one
// is how a tool gets removed from the pipeline. Only bugs exit non-zero.
const failing = strict ? n : bugs;
process.exit(noExit || failing === 0 ? 0 : 1);
