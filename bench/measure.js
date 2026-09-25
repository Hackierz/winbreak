#!/usr/bin/env node
// Run every benchmark item for real on this machine and record what happened.
//
//   node bench/measure.js <label>                e.g. local, ci
//   node bench/measure.js <label> --clean-env    Windows: a stock install
//
// Writes bench/results/<platform>-<label>[-clean].json.
//
// --clean-env exists because "two Windows machines agree" is not ground
// truth. Git for Windows puts rm, cp, cat, grep, sleep, ls and even `true` on
// PATH -- on this author's machine AND on GitHub's windows-latest runner -- so
// both happily agreed that `rm -rf build` works on Windows. Clean mode runs
// every item with PATH cut down to Windows' own system folders plus Node, and
// HOME removed: what a fresh Windows install with only Node and npm has. The benchmark's labels come
// from comparing these files across machines (see build-dataset.js); nothing
// in items.js says what the answer is.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execSync } = require("child_process");

// Deliberately Windows-hostile code lives under fixtures/, which winbreak
// skips by design -- otherwise the repo's own self-check would flag it.
const items = require("./fixtures/items");

const label = (process.argv[2] && !process.argv[2].startsWith("--")) ? process.argv[2] : "local";
const clean = process.argv.includes("--clean-env");
if (clean && process.platform !== "win32") {
  console.error("--clean-env only means something on Windows");
  process.exit(2);
}

// A stock Windows PATH, plus the directory Node was installed into (which is
// also where npm.cmd and npx.cmd live). Nothing from Git, MSYS, Chocolatey or
// anything else a developer machine or a CI image accumulates.
function cleanWindowsEnv() {
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Windows env names are case-insensitive but a plain object is not:
    // drop every spelling of PATH so the child sees exactly one.
    if (/^(path|home)$/i.test(k)) continue;
    env[k] = v;
  }
  env.Path = [
    path.join(sysRoot, "System32"),
    sysRoot,
    path.join(sysRoot, "System32", "Wbem"),
    path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0"),
    path.join(sysRoot, "System32", "OpenSSH"),
    path.dirname(process.execPath),
  ].join(";");
  return env;
}
const childEnv = clean ? cleanWindowsEnv() : process.env;
const benchDir = __dirname;
const fixtureModules = path.join(benchDir, "deps", "node_modules");
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wom-"));
const TIMEOUT_MS = 30000;

if (!fs.existsSync(fixtureModules)) {
  console.error("bench/deps/node_modules is missing: run `npm ci` in bench/deps first");
  process.exit(2);
}

function sh(cmd) {
  // Only used for environment facts, never for items.
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function runItem(item) {
  const dir = path.join(workRoot, item.id);
  fs.mkdirSync(dir, { recursive: true });
  writeFiles(dir, item.files);

  let result;
  if (item.kind === "npm") {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "bench-fixture", version: "1.0.0", private: true,
      scripts: { t: item.script },
    }, null, 2));
    // Share one installed node_modules (cross-env, rimraf, shx) instead of
    // installing per item. A junction needs no privileges on Windows.
    fs.symlinkSync(fixtureModules, path.join(dir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    // `npm` is npm.cmd on Windows, which cannot be spawned without a shell.
    // The command string is fixed, so shell: true concatenates nothing unsafe.
    result = spawnSync("npm run -s t", {
      cwd: dir, shell: true, encoding: "utf8", timeout: TIMEOUT_MS, env: childEnv,
    });
  } else {
    const main = item.kind === "esm" ? "main.mjs" : "main.js";
    fs.writeFileSync(path.join(dir, main), item.code);
    result = spawnSync(process.execPath, [main], {
      cwd: dir, encoding: "utf8", timeout: TIMEOUT_MS, env: childEnv,
    });
  }

  const r = {
    out: (result.stdout || "").trim(),
    err: (result.stderr || "").trim(),
    status: result.status,
    has: (p) => fs.existsSync(path.join(dir, ...p.split("/"))),
    read: (p) => fs.readFileSync(path.join(dir, ...p.split("/")), "utf8").trim(),
    list: () => fs.readdirSync(dir),
  };

  let outcome;
  if (result.error && result.error.code === "ETIMEDOUT") outcome = "fails_loudly";
  else if (r.status !== 0) outcome = "fails_loudly";
  else {
    let ok = false;
    try { ok = Boolean(item.check(r)); } catch { ok = false; }
    outcome = ok ? "works" : "fails_silently";
  }

  return {
    id: item.id,
    outcome,
    status: r.status,
    out: r.out.slice(0, 300),
    err: r.err.split(/\r?\n/).filter(Boolean).slice(0, 3).join(" | ").slice(0, 300),
  };
}

const env = {
  label,
  platform: process.platform,
  release: os.release(),
  arch: process.arch,
  node: process.version,
  npm: sh("npm --version"),
  scriptShell: sh("npm config get script-shell"),
  comspec: process.env.ComSpec || null,
  cleanEnv: clean,
  homeSet: Boolean(childEnv.HOME),
  path: clean ? childEnv.Path : null,
  measuredAt: new Date().toISOString(),
};

const results = [];
for (const item of items) {
  const res = runItem(item);
  results.push(res);
  const mark = { works: "  ok  ", fails_loudly: " LOUD ", fails_silently: "SILENT" }[res.outcome];
  console.log(`[${mark}] ${item.id}${res.outcome === "works" ? "" : "   " + (res.err || res.out).slice(0, 90)}`);
}

fs.mkdirSync(path.join(benchDir, "results"), { recursive: true });
const outFile = path.join(benchDir, "results", `${process.platform}-${label}${clean ? "-clean" : ""}.json`);
fs.writeFileSync(outFile, JSON.stringify({ env, results }, null, 2) + "\n");

const tally = results.reduce((t, r) => ((t[r.outcome] = (t[r.outcome] || 0) + 1), t), {});
console.log(`\n${results.length} items on ${process.platform} (${label}${clean ? ", clean env" : ""}):`, JSON.stringify(tally));
console.log("wrote", path.relative(process.cwd(), outFile));

// Leave nothing behind in the temp directory.
try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* best effort */ }
