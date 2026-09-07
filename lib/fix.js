"use strict";

/**
 * Automatic repair for the two npm-script problems that have one obvious,
 * boring, universally-agreed fix. Everything else is reported and left alone.
 *
 * The survey behind this (599 packages, 214 script findings) split cleanly:
 * about two thirds are `rm -rf dist` or `NODE_ENV=x cmd`, which have a single
 * right answer the ecosystem already standardised on, and the rest are shell
 * programs -- `for` loops, `$(...)`, `${VAR/a/b}`, pipes into sed -- which
 * cannot be mechanically translated to cmd.exe and should become a .mjs file.
 *
 * Guessing at that second group would be the worst thing this tool could do:
 * it edits a file the user cannot easily diff in their head, and a wrong
 * "fix" to a build script fails at a distance. So it refuses, by name.
 */

/** Packages the fixes depend on, with why, for the install line. */
const NEEDS = {
  "cross-env": "runs a command with an environment variable set, on any platform",
  rimraf: "deletes a directory recursively, on any platform",
  shx: "cross-platform cp, mv, mkdir -p and friends, with its own globbing",
};

/**
 * Commands shx provides, with the flags it actually understands.
 *
 * The flag lists are the point. `cp --parents` is a GNU extension shx does not
 * have, and rewriting it to `shx cp --parents` would turn a script that fails
 * loudly into one that fails differently and later. Anything with a flag not
 * listed here is left alone.
 *
 * Verified on Windows 11 from cmd.exe, which is what npm uses:
 *   shx cp src/*.ts dest/   -> copied one.ts and two.ts, not skip.js
 *   shx cp -R src dest2     -> copied the directory
 * shx globs internally, so it does not need the shell to expand `*.ts` first.
 */
const SHX_OK = {
  cp: /^-[rRfnupL]+$/,
  mv: /^-[fn]+$/,
  mkdir: /^-p$/,
  touch: /^-[acmd]+$/,
  // Deliberately NOT here:
  //   ln    - shx has it, but creating a symlink on Windows needs elevation or
  //           developer mode, so the "fix" would fail on the machines that
  //           need it. It stays in UNFIXABLE below, refused by name.
  //   chmod - meaningless on Windows; rewriting it would imply it did
  //           something.
};

/**
 * Split a script into top-level command segments, keeping the separators.
 * Quoted regions are opaque: `echo "a && b"` is one segment, not two.
 * Returns [{ sep, text }], where sep is the operator that PRECEDED the text.
 */
function segments(cmd) {
  const out = [];
  let buf = "";
  let sep = "";
  let quote = null;
  let depth = 0; // (...) and $(...)
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      buf += c;
      if (c === quote && cmd[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; buf += c; continue; }
    if (c === "(") { depth++; buf += c; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); buf += c; continue; }
    if (depth === 0) {
      const two = cmd.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        out.push({ sep, text: buf });
        sep = two; buf = ""; i++;
        continue;
      }
      if (c === ";" || c === "|" || c === "&") {
        out.push({ sep, text: buf });
        sep = c; buf = "";
        continue;
      }
    }
    buf += c;
  }
  out.push({ sep, text: buf });
  return out;
}

/**
 * Shell constructs that cmd.exe cannot run and that no mechanical rewrite can
 * repair. Presence of any of these in a segment means hands off.
 */
const UNFIXABLE = [
  [/\bfor\s+\w+\s+in\b|\bdo\b|\bdone\b|\bif\s*\[|\bfi\b|\bthen\b/, "a shell loop or conditional"],
  [/\$\(|`[^`]*`/, "command substitution"],
  [/\$\{[^}]*[/#%][^}]*\}/, "shell parameter expansion"],
  [/\|\s*(?:grep|sed|awk|xargs|head|tail|sort|uniq|tee|wc)\b/, "a Unix pipeline"],
  [/(?:^|\s)(?:sed|awk|grep|find|xargs|chmod|chown|ln|ps|kill)\s/, "a Unix-only command with no direct equivalent"],
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unfixableReason(text) {
  for (const [re, why] of UNFIXABLE) if (re.test(text)) return why;
  return null;
}

// VAR=value at the head of a segment, one or more, then the real command.
const INLINE_ENV = /^(\s*)((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+)(\S.*)$/;
// rm with recursive and/or force flags, then its operands.
const RM = /^(\s*)rm\s+(-[a-zA-Z]+(?:\s+-[a-zA-Z]+)*)\s+(.+)$/;

/**
 * Repair one script string.
 * @returns {{ fixed: string, changed: boolean, needs: string[], skipped: Array<{text,why}> }}
 */
function fixScript(cmd) {
  const needs = new Set();
  const skipped = [];
  let changed = false;

  const parts = segments(cmd).map((seg) => {
    const why = unfixableReason(seg.text);
    if (why) {
      skipped.push({ text: seg.text.trim(), why });
      return seg;
    }
    let t = seg.text;

    // rm -rf dist  ->  rimraf dist
    const rm = t.match(RM);
    if (rm) {
      const flags = rm[2].replace(/[\s-]/g, "");
      // Only the recursive/force forms. `rm -i` is interactive and `rm` with
      // no flags on a single file is better served by the caller deciding.
      if (/^[rf]+$/.test(flags)) {
        t = `${rm[1]}rimraf ${rm[3]}`;
        needs.add("rimraf");
        changed = true;
      }
    }

    // cp/mv/mkdir -p  ->  shx cp/mv/mkdir -p
    // Only when every flag is one shx implements; see SHX_OK above.
    const shx = t.match(/^(\s*)([a-z]+)((?:\s+-[^\s]+)*)\s+(.+)$/);
    if (shx && Object.prototype.hasOwnProperty.call(SHX_OK, shx[2])) {
      const flags = shx[3].trim().split(/\s+/).filter(Boolean);
      const allKnown = flags.every((f) => SHX_OK[shx[2]].test(f));
      if (allKnown) {
        t = `${shx[1]}shx ${shx[2]}${shx[3]} ${shx[4]}`;
        needs.add("shx");
        changed = true;
      } else {
        skipped.push({
          text: seg.text.trim(),
          why: "a flag shx does not implement (" +
            flags.filter((f) => !SHX_OK[shx[2]].test(f)).join(" ") + ")",
        });
      }
    }

    // NODE_ENV=test node --test  ->  cross-env NODE_ENV=test node --test
    const env = t.match(INLINE_ENV);
    if (env && !/^cross-env\b/.test(env[3])) {
      t = `${env[1]}cross-env ${env[2]}${env[3]}`;
      needs.add("cross-env");
      changed = true;
    }

    return { sep: seg.sep, text: t };
  });

  const fixed = parts
    .map((p) => (p.sep ? p.sep + p.text : p.text))
    .join("");

  return { fixed, changed, needs: [...needs], skipped };
}

/**
 * Repair every script in a parsed package.json object, in place on a copy.
 * @returns {{ scripts: object, changes: Array, needs: string[], skipped: Array }}
 */
function fixPackageJson(pkg) {
  const changes = [];
  const needs = new Set();
  const skipped = [];
  const scripts = Object.assign({}, pkg.scripts);

  for (const name of Object.keys(scripts)) {
    const before = scripts[name];
    if (typeof before !== "string") continue;
    const r = fixScript(before);
    for (const n of r.needs) needs.add(n);
    // One entry per script, not per segment: `for F in x; do y; done` is three
    // segments and one decision, and listing it three times reads like three
    // separate problems.
    if (r.skipped.length) {
      skipped.push({ script: name, text: before, why: r.skipped[0].why });
    }
    if (r.changed && r.fixed !== before) {
      scripts[name] = r.fixed;
      changes.push({ script: name, before, after: r.fixed });
    }
  }

  return { scripts, changes, needs: [...needs], skipped };
}

/**
 * Rewrite the `scripts` values inside the ORIGINAL package.json text, leaving
 * every byte outside them untouched. JSON.stringify would reformat the whole
 * file, reorder nothing but reindent everything, and drop the trailing
 * newline -- turning a two-line fix into a diff nobody will review.
 */
function applyToText(src, changes) {
  let out = src;
  for (const c of changes) {
    // "name" <ws> : <ws> "old value", with both strings JSON-encoded exactly
    // as they appear in the file, and any spacing between them.
    const key = escapeRe(JSON.stringify(c.script));
    const val = escapeRe(JSON.stringify(c.before));
    const re = new RegExp(key + "(\\s*:\\s*)" + val);
    const m = out.match(re);
    if (!m) {
      throw new Error(
        `could not locate the script "${c.script}" in package.json to rewrite it`
      );
    }
    // Only the value is replaced; the key, the spacing and everything around
    // it survive byte for byte.
    out = out.slice(0, m.index) +
      JSON.stringify(c.script) + m[1] + JSON.stringify(c.after) +
      out.slice(m.index + m[0].length);
  }
  return out;
}

module.exports = { fixScript, fixPackageJson, applyToText, segments, NEEDS };
