"use strict";

/**
 * The mirror image of the rest of this tool.
 *
 * Everything else here finds code that works on a Mac and breaks on Windows.
 * This finds code that works on Windows *and* a Mac, and breaks on Linux --
 * because both of those filesystems are case-insensitive by default and Linux
 * is not. `require("./foo")` happily loads `Foo.js` on the machine you wrote
 * it on, and fails in CI with "Cannot find module './foo'".
 *
 * The reason this class of bug survives is that the obvious check does not
 * catch it. Verified on Windows 11:
 *
 *     the file on disk is Foo.js
 *     fs.existsSync(".../Foo.js")  -> true
 *     fs.existsSync(".../foo.js")  -> true      <- the lie
 *     fs.readdirSync(dir)          -> ["Foo.js"]
 *
 * So this reads the directory and compares real entry names. It never asks the
 * filesystem whether a path exists, because on the machines where this bug is
 * written the answer is always yes.
 *
 * It only reports a mismatch when a case-insensitive match exists and an exact
 * one does not. An import that matches nothing at all is a missing file, which
 * is somebody else's error to report.
 */

const fs = require("fs");
const path = require("path");

/** Extensions Node will try when the specifier has none. Order matters. */
const TRY_EXT = ["", ".js", ".mjs", ".cjs", ".json", ".node",
  ".ts", ".mts", ".cts", ".tsx", ".jsx"];

/** require("./x"), import ... from "./x", import("./x"), export ... from "./x" */
const SPECIFIER = /(?:require\s*\(\s*|import\s*\(\s*|(?:^|[\s;}])(?:import|export)\b[^;'"]*?\bfrom\s*)(['"])(\.\.?\/[^'"]*)\1/g;

const dirCache = new Map();

function entries(dir) {
  if (dirCache.has(dir)) return dirCache.get(dir);
  let list = null;
  try {
    list = fs.readdirSync(dir);
  } catch (e) {
    list = null; // not a directory, or unreadable -- not our problem
  }
  dirCache.set(dir, list);
  return list;
}

/**
 * Does `name` exist in `dir` with exactly this spelling, and if not, is there
 * an entry that differs only by case?
 * @returns {null | {actual: string}} null when there is nothing to report
 */
function caseMismatch(dir, name) {
  const list = entries(dir);
  if (!list) return null;
  if (list.indexOf(name) !== -1) return null; // exact match, fine

  const lower = name.toLowerCase();
  for (const e of list) {
    if (e.toLowerCase() === lower) return { actual: e };
  }
  return null; // nothing close; a missing file, not a case bug
}

/**
 * Resolve a relative specifier the way Node would, but case-sensitively,
 * reporting the first component whose spelling is wrong.
 *
 * @returns {null | {want: string, actual: string, kind: string}}
 */
function checkSpecifier(fromFile, spec) {
  const baseDir = path.dirname(fromFile);
  // Strip any query/hash a bundler might allow.
  const clean = spec.replace(/[?#].*$/, "");
  const parts = clean.split("/").filter((p) => p !== "" && p !== ".");

  let dir = baseDir;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "..") { dir = path.dirname(dir); continue; }

    const last = i === parts.length - 1;
    if (!last) {
      const bad = caseMismatch(dir, part);
      if (bad) return { want: part, actual: bad.actual, kind: "directory" };
      dir = path.join(dir, part);
      continue;
    }

    // Final component: it may be a file with any of several extensions, or a
    // directory containing an index file.
    const list = entries(dir);
    if (!list) return null;

    for (const ext of TRY_EXT) {
      const candidate = part + ext;
      if (list.indexOf(candidate) !== -1) return null; // exact hit
    }
    // No exact hit. Is there a case-insensitive one?
    const lowerSet = new Map();
    for (const e of list) lowerSet.set(e.toLowerCase(), e);
    for (const ext of TRY_EXT) {
      const candidate = (part + ext).toLowerCase();
      if (lowerSet.has(candidate)) {
        return { want: part + ext, actual: lowerSet.get(candidate), kind: "file" };
      }
    }
    return null;
  }
  return null;
}

/**
 * Find case-mismatched relative imports in one already-read source file.
 * @param {string} src   file contents
 * @param {string} file  absolute path of that file
 * @returns {Array} findings in the same shape the text rules produce
 */
function scanImports(src, file) {
  const out = [];
  // Line offsets, computed the same way core.js does -- getting this wrong
  // with CRLF was a real bug once and it made every finding drift.
  const lines = src.split(/\r?\n/);
  const offsets = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + (src.indexOf("\r\n") !== -1 ? 2 : 1);
  }
  const lineOf = (index) => {
    let lo = 0, hi = offsets.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= index) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };

  SPECIFIER.lastIndex = 0;
  let m;
  while ((m = SPECIFIER.exec(src)) !== null) {
    const spec = m[2];
    let bad = null;
    try {
      bad = checkSpecifier(file, spec);
    } catch (e) {
      bad = null; // a malformed path is not worth failing a scan over
    }
    if (!bad) continue;

    // NOT m.index. The pattern starts with (?:^|[\s;}]) so that `import` is a
    // whole word, and that leading character is very often the newline that
    // ENDED THE PREVIOUS LINE -- which reported every `import ... from` finding
    // one line too early. Anchor on the quoted specifier instead, which is
    // unambiguously inside the line it belongs to.
    const quoted = m[1] + spec + m[1];
    const rel = m[0].indexOf(quoted);
    const ln = lineOf(m.index + (rel === -1 ? 0 : rel));
    const raw = (lines[ln] || "").trim();
    if (raw.length > 500) continue; // minified

    out.push({
      rule: "import-case-mismatch",
      severity: "bug",
      title: "An import's case does not match the file on disk",
      file,
      line: ln + 1,
      source: raw.length > 200 ? raw.slice(0, 197) + "..." : raw,
      why:
        "This works on Windows and macOS, whose filesystems are " +
        "case-insensitive, and fails on Linux -- which is what almost every CI " +
        "runner and container uses. The import asks for \"" + bad.want +
        "\" and the " + bad.kind + " on disk is \"" + bad.actual + "\". On Linux " +
        "the module is simply not found. `fs.existsSync` will not catch this " +
        "for you: on a case-insensitive filesystem it returns true for either " +
        "spelling.",
      fix:
        "Change the import to match the file exactly: \"" + bad.actual +
        "\". Renaming the file instead is riskier -- git on a case-insensitive " +
        "filesystem may not record a rename that only changes case, so use " +
        "`git mv --force` if you go that way.",
    });
  }
  return out;
}

module.exports = { scanImports, checkSpecifier, caseMismatch };
