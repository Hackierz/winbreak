#!/usr/bin/env node
// Run every benchmark item for real on this machine and record what happened.
//
//   node bench/measure.js <label>        e.g. local, ci
//
// Writes bench/results/<platform>-<label>.json. The benchmark's labels come
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

const label = process.argv[2] || "local";
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
      cwd: dir, shell: true, encoding: "utf8", timeout: TIMEOUT_MS,
    });
  } else {
    const main = item.kind === "esm" ? "main.mjs" : "main.js";
    fs.writeFileSync(path.join(dir, main), item.code);
    result = spawnSync(process.execPath, [main], {
      cwd: dir, encoding: "utf8", timeout: TIMEOUT_MS,
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
  homeSet: Boolean(process.env.HOME),
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
const outFile = path.join(benchDir, "results", `${process.platform}-${label}.json`);
fs.writeFileSync(outFile, JSON.stringify({ env, results }, null, 2) + "\n");

const tally = results.reduce((t, r) => ((t[r.outcome] = (t[r.outcome] || 0) + 1), t), {});
console.log(`\n${results.length} items on ${process.platform} (${label}):`, JSON.stringify(tally));
console.log("wrote", path.relative(process.cwd(), outFile));

// Leave nothing behind in the temp directory.
try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* best effort */ }
