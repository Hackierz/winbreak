"use strict";

const fs = require("fs");
const path = require("path");
const { scanSource } = require("./core");

const DEFAULT_EXTS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"];
const SKIP_DIRS = new Set([
  "node_modules", ".git", "coverage",
  ".next", ".nuxt", ".cache", "vendor", ".venv", "__pycache__",
]);

/**
 * Build output. Skipped by default, but never silently.
 *
 * In a source repo `dist/` is generated and scanning it just reports the same
 * bug twice. In a package downloaded from npm, `dist/` is the entire product —
 * skipping it reports "1 bug in 2 files" for a package with 43 files, which
 * looks like a clean bill of health and is the exact silent-failure behaviour
 * this tool exists to complain about. So we count what we skipped and say so.
 */
const BUILD_DIRS = new Set(["dist", "build", "out"]);

/** Files above this size are almost always bundles. Scanning them is noise. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Test files are skipped by default.
 *
 * Fixtures and mocks are full of deliberate POSIX paths — "/home/testuser",
 * "/usr/bin/node" — that are not bugs and never run in production. Reporting
 * them buries the real findings. Pass --include-tests to scan them anyway.
 */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__", "spec", "fixtures", "e2e"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

function looksLikeTest(file) {
  if (TEST_FILE.test(path.basename(file))) return true;
  return file.split(/[\\/]/).some((seg) => TEST_DIRS.has(seg));
}

function walk(dir, exts, files = [], skipped = null) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files; // unreadable directory is not our problem to report
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".bin") {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (skipped && BUILD_DIRS.has(e.name)) {
        skipped.dirs.add(e.name);
        skipped.files += walk(full, exts, []).length;
        continue;
      }
      walk(full, exts, files, skipped);
    } else if (exts.includes(path.extname(e.name))) {
      files.push(full);
    }
  }
  return files;
}

/** Scan one file. Returns an array of findings. */
function scanFile(file, opts = {}) {
  let src;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) return [];
    src = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return scanSource(src, file, opts);
}

/** Scan a directory or a single file. */
function scan(target, opts = {}) {
  const exts = opts.exts || DEFAULT_EXTS;
  const stat = fs.statSync(target);
  // The test-file filter applies to directory walks only. If someone names a
  // file on the command line they want that file scanned, even if it lives
  // under test/ — otherwise `winbreak test/thing.js` silently reports nothing
  // and looks like a clean bill of health.
  let files;
  const skipped = { files: 0, dirs: new Set() };
  if (stat.isDirectory()) {
    files = walk(target, exts, [], opts.includeBuild ? null : skipped);
    if (!opts.includeTests) files = files.filter((f) => !looksLikeTest(f));
  } else {
    files = [target];
  }
  const findings = [];
  for (const f of files) findings.push(...scanFile(f, opts));
  findings.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file));
  return {
    files: files.length,
    findings,
    skippedBuild: { files: skipped.files, dirs: [...skipped.dirs] },
  };
}

module.exports = { scan, scanFile, scanSource, looksLikeTest, DEFAULT_EXTS };
