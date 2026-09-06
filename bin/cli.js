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
  --include-tests            also scan test files (skipped by default)
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
const target = args.find((a) => !a.startsWith("-")) || ".";

let result;
try {
  result = scan(path.resolve(target), { includeTests: args.includes("--include-tests") });
} catch (e) {
  console.error(`winbreak: cannot read ${target} — ${e.message}`);
  process.exit(2);
}

if (json) {
  console.log(JSON.stringify(
    { scanned: result.files, count: result.findings.length, findings: result.findings },
    null, 2));
  process.exit(noExit || result.findings.length === 0 ? 0 : 1);
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
      console.log(`  ${yellow(String(f.line).padStart(5))}  ${red(f.title)}  ${dim(f.rule)}`);
      if (f.source) console.log(`         ${dim(f.source)}`);
      console.log(`         ${dim("why:")} ${f.why}`);
      console.log(`         ${cyan("fix:")} ${f.fix}`);
    }
  }
}

const n = result.findings.length;
console.log();
if (n === 0) {
  console.log(green(`✓ nothing found — scanned ${result.files} file${result.files === 1 ? "" : "s"}`));
} else {
  const kinds = new Set(result.findings.map((f) => f.rule)).size;
  console.log(
    `${red(`${n} finding${n === 1 ? "" : "s"}`)} across ${kinds} rule${kinds === 1 ? "" : "s"} ` +
    `in ${result.files} file${result.files === 1 ? "" : "s"}`);
  console.log(dim("these are heuristics — read each one before you change anything"));
}

process.exit(noExit || n === 0 ? 0 : 1);
