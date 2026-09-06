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
  --json                     machine-readable output
  --quiet                    only the summary line
  --rules                    list the rules and exit
  --strict                   also fail the build on smells, not just bugs
  --include-tests            also scan test files (skipped by default)
  --include-build            also scan dist/ build/ out/ (skipped by default)
  --no-exit-code             always exit 0, even with findings
  -h, --help                 this

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

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const red = (s) => c(31, s);
const yellow = (s) => c(33, s);
const green = (s) => c(32, s);
const cyan = (s) => c(36, s);

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
