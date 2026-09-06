"use strict";

/**
 * GitHub Actions output: workflow commands that put each finding on the line
 * it belongs to, in the pull request diff.
 *
 * This is the difference between a checker people run once and a checker that
 * stays in a project. A log line saying "3 bugs" is something a reviewer has
 * to go and look for; an annotation on the changed line is something they
 * cannot miss. The whole point of this tool is catching a Windows bug before
 * a Windows user does, and the review is the last moment that is cheap.
 *
 * Spec: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 */

const path = require("path");

/**
 * Escape a workflow-command MESSAGE. A raw newline would end the command and
 * silently truncate the annotation.
 */
function escapeData(s) {
  return String(s)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/** Escape a workflow-command PROPERTY value, which also cannot hold : or , */
function escapeProp(s) {
  return escapeData(s)
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/**
 * GitHub matches annotations to the diff by a path relative to the repository
 * root, with forward slashes. An absolute Windows path silently produces an
 * annotation attached to nothing -- it appears in the log and never on the
 * file, which looks like the tool found less than it did.
 */
function repoPath(file, root) {
  const rel = path.relative(root, file);
  return rel.split(path.sep).join("/");
}

/** One `::error` / `::warning` line per finding. */
function annotations(findings, root) {
  return findings.map((f) => {
    const level = f.severity === "smell" ? "warning" : "error";
    const props = [
      `file=${escapeProp(repoPath(f.file, root))}`,
      `line=${f.line}`,
      `title=${escapeProp("winbreak: " + f.title)}`,
    ].join(",");
    // The fix is the useful half, so it goes in the annotation body rather
    // than being left in a log the reviewer will not open.
    const body = `${f.why}\n\nFix: ${f.fix}\n\nRule: ${f.rule}`;
    return `::${level} ${props}::${escapeData(body)}`;
  });
}

/** A markdown table for $GITHUB_STEP_SUMMARY. */
function summary(result, root, opts) {
  const o = opts || {};
  const findings = result.findings;
  const bugs = findings.filter((f) => f.severity !== "smell");
  const smells = findings.length - bugs.length;
  const lines = [];

  lines.push("## winbreak");
  lines.push("");
  if (!findings.length) {
    lines.push(
      `No Windows-portability problems found in ${result.files} ` +
      `file${result.files === 1 ? "" : "s"}.`);
  } else {
    lines.push(
      `**${bugs.length} bug${bugs.length === 1 ? "" : "s"}**` +
      (smells ? ` and ${smells} smell${smells === 1 ? "" : "s"}` : "") +
      ` in ${result.files} file${result.files === 1 ? "" : "s"}.`);
    lines.push("");
    lines.push("| | File | Line | What |");
    lines.push("|---|---|---|---|");
    // A summary with 400 rows is not a summary, and GitHub truncates the page
    // at 1 MB anyway.
    for (const f of findings.slice(0, 50)) {
      const icon = f.severity === "smell" ? "warning" : "bug";
      const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(
        `| ${icon} | \`${cell(repoPath(f.file, root))}\` | ${f.line} | ` +
        `${cell(f.title)} |`);
    }
    if (findings.length > 50) {
      lines.push("");
      lines.push(`_...and ${findings.length - 50} more. See the annotations._`);
    }
  }

  const sb = result.skippedBuild;
  if (sb && sb.files > 0) {
    lines.push("");
    lines.push(
      `> Skipped ${sb.files} file${sb.files === 1 ? "" : "s"} in ` +
      `${sb.dirs.map((d) => "`" + d + "/`").join(", ")}. ` +
      "Set `include-build: true` to scan build output.");
  }

  if (o.fixable) {
    lines.push("");
    lines.push(
      `> ${o.fixable} of these can be repaired automatically with ` +
      "`npx winbreak --fix`.");
  }

  lines.push("");
  return lines.join("\n");
}

module.exports = { annotations, summary, escapeData, escapeProp, repoPath };
