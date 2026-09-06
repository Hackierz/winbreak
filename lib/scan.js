"use strict";

const fs = require("fs");
const path = require("path");
const { rules } = require("./rules");

const DEFAULT_EXTS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"];
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".cache", "vendor", ".venv", "__pycache__",
]);

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

function walk(dir, exts, files = []) {
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
      walk(full, exts, files);
    } else if (exts.includes(path.extname(e.name))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Pull out the text of a call expression starting at `from`.
 *
 * Naive paren matching that ignores parens inside string literals. It is not a
 * parser and does not pretend to be — it just needs enough of the call to see
 * whether the options object sets `shell`.
 */
function extractCall(src, from, limit = 2000) {
  const open = src.indexOf("(", from);
  if (open === -1) return src.slice(from, from + 200);
  let depth = 0;
  let quote = null;
  for (let i = open; i < Math.min(src.length, open + limit); i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from, Math.min(src.length, open + limit));
}

const CALL_START = /\b(?:child_process\.)?(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/g;

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

  const lines = src.split(/\r?\n/);

  // Line offsets must come from the real newline positions, not from
  // `length + 1`. A CRLF file eats two characters per line break, so the
  // assumed-one-character version drifts further out with every line and
  // reports findings against the wrong line. On Windows — the whole point of
  // this tool — CRLF is the default. Found by running winbreak on itself.
  const lineStart = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) lineStart.push(i + 1);
  }
  const lineOf = (idx) => {
    let lo = 0, hi = lineStart.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStart[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  // One hop of variable tracking. The classic shape is:
  //   const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  //   spawn(npmCmd, args, { stdio: "inherit" });          // <- EINVAL
  // The spawn call itself never mentions ".cmd", so a call-only regex misses
  // it. We do not chase further than one hop; see README "What it misses".
  const cmdVars = new Set();
  for (const l of lines) {
    const m = l.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m && /\.cmd|\.bat/.test(l)) cmdVars.add(m[1]);
  }

  const findings = [];
  const seen = new Set();
  const push = (rule, lineNo) => {
    if (lines[lineNo] && /winbreak-ignore/.test(lines[lineNo])) return;
    if (lineNo > 0 && /winbreak-ignore-next/.test(lines[lineNo - 1])) return;
    const key = `${rule.id}:${lineNo}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      rule: rule.id,
      title: rule.title,
      why: rule.why,
      fix: rule.fix,
      file,
      line: lineNo + 1,
      source: (lines[lineNo] || "").trim().slice(0, 160),
    });
  };

  // --- call-scoped rules ---
  const callRules = rules.filter((r) => r.scope === "call");
  if (callRules.length) {
    CALL_START.lastIndex = 0;
    let m;
    while ((m = CALL_START.exec(src)) !== null) {
      const lineNo = lineOf(m.index);
      // Skip matches inside a comment. A line like
      //   // never spawn(foo.cmd) without a shell
      // is documentation, not a call, and flagging it is pure noise.
      const before = src.slice(lineStart[lineNo], m.index);
      if (before.includes("//") || /^\s*\*/.test(before)) continue;
      const call = extractCall(src, m.index);
      const nearby = lines.slice(Math.max(0, lineNo - 6), lineNo + 6).join("\n");
      for (const rule of callRules) {
        try {
          if (rule.test(call, { nearby, file, cmdVars })) push(rule, lineNo);
        } catch { /* a rule must never take the run down */ }
      }
    }
  }

  // --- line-scoped rules ---
  const lineRules = rules.filter((r) => r.scope === "line");
  if (lineRules.length) {
    for (let i = 0; i < lines.length; i++) {
      const nearby = lines.slice(Math.max(0, i - 6), i + 6).join("\n");
      for (const rule of lineRules) {
        try {
          if (rule.test(lines[i], { nearby, file })) push(rule, i);
        } catch { /* ignore */ }
      }
    }
  }

  return findings;
}

/** Scan a directory or a single file. */
function scan(target, opts = {}) {
  const exts = opts.exts || DEFAULT_EXTS;
  const stat = fs.statSync(target);
  let files = stat.isDirectory() ? walk(target, exts) : [target];
  if (!opts.includeTests) files = files.filter((f) => !looksLikeTest(f));
  const findings = [];
  for (const f of files) findings.push(...scanFile(f, opts));
  findings.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file));
  return { files: files.length, findings };
}

module.exports = { scan, scanFile, looksLikeTest, DEFAULT_EXTS };
