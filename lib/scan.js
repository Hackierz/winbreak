"use strict";

const fs = require("fs");
const path = require("path");
const { rules } = require("./rules");

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

/** Remove string literals so their braces do not confuse the brace counter. */
function stripStrings(line) {
  return line
    .replace(/\\./g, "")
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, "``")
    .replace(/\/\/.*$/, "");
}

/** How far back to look for enclosing blocks. Bounds the cost on huge files. */
const BLOCK_SCAN_LIMIT = 400;

/**
 * The header lines of every block that encloses `lineNo`.
 *
 * A platform guard is nearly always `if (isWindows) { … } else { … }` wrapping
 * a whole function, so the condition can sit a hundred lines above the call
 * being judged. But a flat look-back window is the wrong tool: it also sees
 * unrelated code that merely mentions the platform somewhere else in the file,
 * and suppresses real bugs. nodemon needed 87 lines of reach; Coinbase's awal
 * has a genuine `rm -rf` bug in a file that mentions win32 in a different
 * function entirely. One window cannot serve both.
 *
 * So walk the braces instead and collect only true ancestors. When the
 * enclosing block opens with `else`, follow the chain back to the matching
 * `if`, because that is where the condition actually lives.
 */
function enclosingBlock(lines, lineNo) {
  const parts = [];
  let depth = 0;
  let wantElseMate = false;
  const stop = Math.max(0, lineNo - BLOCK_SCAN_LIMIT);
  for (let i = lineNo; i >= stop; i--) {
    const line = stripStrings(lines[i] || "");
    for (let k = line.length - 1; k >= 0; k--) {
      const c = line[k];
      if (c === "}") depth++;
      else if (c === "{") {
        if (depth === 0) {
          parts.push(line.trim());
          wantElseMate = /\belse\b/.test(line);
        } else {
          depth--;
          // Closing brace of the sibling block an `else` belongs to. Its
          // opener carries the condition, so keep it; an `else if` chain
          // keeps the flag set and we follow it further back.
          if (depth === 0 && wantElseMate) {
            parts.push(line.trim());
            wantElseMate = /\belse\b/.test(line);
          }
        }
      }
    }
    if (parts.length >= 12) break;
  }
  return parts.join("\n");
}

/** Scan one file. Returns an array of findings. */
function scanFile(file, opts = {}) {
  // A .d.ts file is type declarations. None of it is executed, so none of it
  // can break on Windows. nx ships `NX_TMP_DIR_POSIX = "/tmp/.nx"` in one and
  // it was reported twice — once in the declaration, once in the real file.
  if (/\.d\.[cm]?ts$/i.test(file)) return [];

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
      severity: rule.severity || "bug",
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
      const guardScope = enclosingBlock(lines, lineNo);
      for (const rule of callRules) {
        try {
          if (rule.test(call, { nearby, guardScope, file, cmdVars })) push(rule, lineNo);
        } catch { /* a rule must never take the run down */ }
      }
    }
  }

  // --- line-scoped rules ---
  const lineRules = rules.filter((r) => r.scope === "line");
  if (lineRules.length) {
    for (let i = 0; i < lines.length; i++) {
      const nearby = lines.slice(Math.max(0, i - 6), i + 6).join("\n");
      // Line rules need guard detection too. `hardcoded-posix-path` had none,
      // so it reported the POSIX half of a platform branch as a bug — six
      // false positives in npm-check-updates alone.
      //
      // Computed lazily. Walking the braces on every line of every file would
      // be quadratic, and webpack alone is 816 files.
      let scope;
      const ctx = {
        nearby,
        file,
        get guardScope() {
          if (scope === undefined) scope = enclosingBlock(lines, i);
          return scope;
        },
      };
      for (const rule of lineRules) {
        try {
          if (rule.test(lines[i], ctx)) push(rule, i);
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

module.exports = { scan, scanFile, looksLikeTest, DEFAULT_EXTS };
