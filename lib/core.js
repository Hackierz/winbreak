"use strict";

/**
 * The scanner, with no filesystem in it.
 *
 * Split out of scan.js so the same code can run in a browser. The web checker
 * on opusmill.com loads this file verbatim — if the rules and this file are
 * the single source of truth, the web version can never quietly drift from
 * what `winbreak` on the command line reports.
 *
 * Nothing here may require("fs") or require("path").
 */

const { rules } = require("./rules");

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
  // Text of the sibling block we are currently walking back through, so we can
  // tell whether it leaves the function before reaching our line.
  let siblingBody = "";
  const stop = Math.max(0, lineNo - BLOCK_SCAN_LIMIT);
  for (let i = lineNo; i >= stop; i--) {
    const raw = lines[i] || "";
    if (depth > 0) siblingBody = raw + "\n" + siblingBody;
    // Count braces on the stripped line so a brace inside a string cannot
    // throw off the depth — but collect the ORIGINAL line. Collecting the
    // stripped one turned `if (os === 'linux') {` into `if (os === '') {`,
    // which hid the platform name from guard detection and made a correctly
    // guarded `which` call in agent-browser look unguarded.
    const line = stripStrings(raw);

    // An early return is a guard too:
    //     if (process.platform === "win32") return;
    //     exec("ps ...");            // never reached on Windows
    // It is not a block that encloses the finding, so the brace walk alone
    // cannot see it. Collect it when we are still at the finding's own nesting
    // level (depth 0) and the line both names a platform and leaves.
    if (
      depth === 0 &&
      i !== lineNo &&
      /\bif\b/.test(line) &&
      /\breturn\b|\bthrow\b|process\.exit/.test(line) &&
      /process\.platform|os\.platform\(\)|isWindows|isWin\b|IS_WINDOWS|["'`](?:win32|linux|darwin)["'`]/i.test(raw)
    ) {
      parts.push(raw.trim());
    }

    for (let k = line.length - 1; k >= 0; k--) {
      const c = line[k];
      if (c === "}") depth++;
      else if (c === "{") {
        if (depth === 0) {
          parts.push(raw.trim());
          wantElseMate = /\belse\b/.test(line);
        } else {
          depth--;
          if (depth === 0) {
            // Closing brace of the sibling block an `else` belongs to. Its
            // opener carries the condition, so keep it; an `else if` chain
            // keeps the flag set and we follow it further back.
            if (wantElseMate) {
              parts.push(raw.trim());
              wantElseMate = /\belse\b/.test(line);
            } else if (
              // A multi-line early return, which is the same guard as
              //   if (win32) return;
              // spread over a block. metaharness does exactly this:
              //   if (platform === 'win32') { …powershell…; return … }
              //   spawnSync('ps', …)              // never reached on Windows
              // The block does not enclose our line, and only leaves before
              // it, so the brace walk alone never sees the condition.
              /\bif\b/.test(line) &&
              /process\.platform|os\.platform\(\)|isWindows|isWin\b|IS_WINDOWS|["'`](?:win32|linux|darwin)["'`]/i.test(raw) &&
              /\breturn\b|\bthrow\b|process\.exit/.test(siblingBody)
            ) {
              parts.push(raw.trim());
            }
            siblingBody = "";
          }
        }
      }
    }
    if (parts.length >= 12) break;
  }
  return parts.join("\n");
}

/**
 * Scan source text. Returns an array of findings.
 *
 * `file` is only used for reporting and for the `.d.ts` check — nothing is
 * read from disk.
 */
/**
 * Scan the `scripts` block of a package.json.
 *
 * This is where the most common Windows bug in the ecosystem actually lives —
 * `cross-env` does about 18M downloads a week and exists for no other reason.
 * Scanning only .js files missed it completely.
 *
 * Line numbers are found by searching the raw text for the script name, so the
 * report points at the line you have to edit rather than at "package.json".
 */
function scanPackageJson(src, file = "package.json") {
  let pkg;
  try {
    pkg = JSON.parse(src);
  } catch {
    return []; // not our job to report malformed JSON
  }
  const scripts = pkg && pkg.scripts;
  if (!scripts || typeof scripts !== "object") return [];

  const lines = src.split(/\r?\n/);
  const scriptRules = rules.filter((r) => r.scope === "script");
  const findings = [];
  const seen = new Set();

  for (const [name, cmd] of Object.entries(scripts)) {
    if (typeof cmd !== "string") continue;
    const needle = '"' + name + '"';
    let lineNo = lines.findIndex((l) => l.includes(needle));
    if (lineNo < 0) lineNo = 0;
    if (/winbreak-ignore/.test(lines[lineNo] || "")) continue;

    for (const rule of scriptRules) {
      try {
        if (!rule.test(cmd, { name, pkg, file })) continue;
        const key = `${rule.id}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          rule: rule.id,
          severity: rule.severity || "bug",
          title: rule.title,
          why: rule.why,
          fix: rule.fix,
          file,
          line: lineNo + 1,
          source: `"${name}": ${JSON.stringify(cmd).slice(0, 150)}`,
        });
      } catch { /* a rule must never take the run down */ }
    }
  }
  findings.sort((a, b) => a.line - b.line);
  return findings;
}

function scanSource(src, file = "input.js", opts = {}) {
  // package.json is a different shape entirely: the bugs live in `scripts`,
  // not in JavaScript syntax.
  if (/(^|[\\/])package\.json$/i.test(file)) return scanPackageJson(src, file);

  // A .d.ts file is type declarations. None of it is executed, so none of it
  // can break on Windows. nx ships `NX_TMP_DIR_POSIX = "/tmp/.nx"` in one and
  // it was reported twice — once in the declaration, once in the real file.
  if (/\.d\.[cm]?ts$/i.test(file)) return [];

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
    // Minified code. A whole bundle on one line cannot be read by a human or
    // by this scanner: there is no enclosing block to walk, no guard to find,
    // and "line 1" tells the reader nothing they can act on. Next.js ships
    // cross-spawn this way -- the library that exists to FIX .cmd spawning --
    // and it was reported as a .cmd spawn bug.
    //
    // 500 characters, not 1000: os-browserify's entire bundle is one 816-char
    // line. No human writes a 500-character line.
    if ((lines[lineNo] || "").length > 500) return;
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

  findings.sort((a, b) => a.line - b.line);
  return findings;
}

module.exports = {
  scanSource,
  scanPackageJson,
  extractCall,
  enclosingBlock,
  stripStrings,
  CALL_START,
  BLOCK_SCAN_LIMIT,
};
