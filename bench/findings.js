#!/usr/bin/env node
// Turn Kaggle run logs into the tables the write-up is built from.
//
//   node bench/findings.js <log.txt> [more logs...] [--out findings.md]
//
// Reads every "WOMM_BREAKDOWN {json}" line in the given files (paste whatever
// the Kaggle runs printed; everything else is ignored), joins the answers with
// bench/dataset.json, and prints Markdown. It describes the data and nothing
// else: every number comes from a log line, and every "what Windows did" comes
// from the measured evidence.
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
let outFile = null;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") outFile = args[++i];
  else inputs.push(args[i]);
}
if (!inputs.length) {
  console.error("usage: node bench/findings.js <log.txt> [more logs...] [--out findings.md]");
  process.exit(2);
}

const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset.json"), "utf8"));
const byId = Object.fromEntries(dataset.items.map((it) => [it.item_id, it]));
const OUTCOMES = ["works", "fails_loudly", "fails_silently"];

// ---- parse -----------------------------------------------------------------
const runs = new Map(); // model -> breakdown; a later line for the same model wins
for (const file of inputs) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const at = line.indexOf("WOMM_BREAKDOWN ");
    if (at < 0) continue;
    let b;
    try {
      b = JSON.parse(line.slice(at + "WOMM_BREAKDOWN ".length));
    } catch (e) {
      console.error(`skipping an unreadable WOMM_BREAKDOWN line in ${file}: ${e.message}`);
      continue;
    }
    if (!b.model || !b.predictions) {
      console.error(`skipping a WOMM_BREAKDOWN line in ${file} with no model/predictions (older notebook?)`);
      continue;
    }
    runs.set(b.model, b);
  }
}
if (!runs.size) {
  console.error("no usable WOMM_BREAKDOWN lines found");
  process.exit(1);
}
const models = [...runs.values()].sort((a, b) => b.balanced_accuracy - a.balanced_accuracy);
const n = models.length;

// ---- helpers ---------------------------------------------------------------
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const f3 = (x) => x.toFixed(3);
const short = (s, len = 90) => (s.length > len ? s.slice(0, len - 1) + "…" : s);
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();
const tick = (s) => "`" + String(s).replace(/`/g, "'") + "`";
const table = (head, rows) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const out = [];
const say = (s = "") => out.push(s);

say(`# Works on My Mac — findings from ${n} model run${n === 1 ? "" : "s"}`);
say();
say(`${dataset.items.length} items: ${OUTCOMES.map((o) => `${dataset.items.filter((i) => i.label === o).length} ${o}`).join(", ")}. ` +
  "Score = balanced accuracy (mean recall over the three outcomes); a constant answer scores 0.333.");
say();

// ---- 1. leaderboard ----------------------------------------------------------
say("## 1. Leaderboard");
say();
say(table(["#", "Model", "Balanced acc.", "95% CI", "Raw acc.", "Unparseable", "API errors"],
  models.map((m, i) => [i + 1, tick(m.model), f3(m.balanced_accuracy),
    m.ci_halfwidth == null ? "–" : `±${f3(m.ci_halfwidth)}`, pct(m.accuracy), m.unparseable, m.errors ?? "–"])));
say();
const ties = [];
for (let i = 0; i + 1 < models.length; i++) {
  const a = models[i], b = models[i + 1];
  if (a.ci_halfwidth != null && b.ci_halfwidth != null &&
      a.balanced_accuracy - a.ci_halfwidth <= b.balanced_accuracy + b.ci_halfwidth) ties.push(`${tick(a.model)} / ${tick(b.model)}`);
}
say(ties.length
  ? `Neighbours whose intervals overlap (the order between them is not established by 66 items): ${ties.join("; ")}.`
  : "No neighbouring pair has overlapping intervals.");
const nearChance = models.filter((m) => m.balanced_accuracy - (m.ci_halfwidth || 0) <= 1 / 3);
if (nearChance.length) say(`Not clearly better than giving the same answer every time (the bottom of the interval is at or below 0.333): ${nearChance.map((m) => `${tick(m.model)} ${f3(m.balanced_accuracy)}`).join(", ")}.`);
const lost = models.filter((m) => (m.errors || 0) + m.unparseable > 0);
if (lost.length) say(`Answers lost to parsing or API errors (scored wrong): ${lost.map((m) => `${tick(m.model)} ${m.unparseable + (m.errors || 0)}`).join(", ")}.`);
say();

// ---- 2. loud vs silent ------------------------------------------------------
say("## 2. Loud failures vs silent failures");
say();
say("Recall per outcome: of the items that really do X on Windows, how many did the model say X for.");
say();
say(table(["Model", "works", "fails_loudly", "fails_silently", "loud − silent"],
  models.map((m) => [tick(m.model), pct(m.recall_works), pct(m.recall_fails_loudly), pct(m.recall_fails_silently),
    (m.recall_fails_loudly != null && m.recall_fails_silently != null)
      ? `${Math.round((m.recall_fails_loudly - m.recall_fails_silently) * 100)} pts` : "–"])));
say();
const gapPositive = models.filter((m) => m.recall_fails_loudly > m.recall_fails_silently).length;
say(`${gapPositive} of ${n} models recall loud failures better than silent ones.`);
say();

// ---- 3. what models said about silent failures ------------------------------
const silentIds = dataset.items.filter((i) => i.label === "fails_silently").map((i) => i.item_id);
const brokenIds = dataset.items.filter((i) => i.label !== "works").map((i) => i.item_id);
say("## 3. Right that it breaks, wrong about how");
say();
say(table(["Model", "broken items flagged as broken", "…but with the wrong failure mode", "silent failures called `works`", "silent failures called `fails_loudly`"],
  models.map((m) => {
    const p = m.predictions;
    return [tick(m.model), pct(m.broken_detected), m.wrong_failure_mode,
      silentIds.filter((id) => p[id] === "works").length, silentIds.filter((id) => p[id] === "fails_loudly").length];
  })));
say();
say(`(${silentIds.length} silent-failure items, ${brokenIds.length} broken items in total.)`);
say();

// ---- 4. per-item difficulty -------------------------------------------------
const perItem = dataset.items.map((it) => {
  const answers = models.map((m) => m.predictions[it.item_id] || "missing");
  const wrong = answers.filter((a) => a !== it.label).length;
  const saidBroken = answers.filter((a) => a.startsWith("fails")).length;
  const tally = {};
  for (const a of answers) tally[a] = (tally[a] || 0) + 1;
  return { it, wrong, saidBroken, tally };
});
const describeTally = (t) => Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(", ");

say("## 4. Works on Windows, flagged anyway");
say();
// Only real answers count as a false alarm; an API error or an unreadable
// answer is not a claim that the code breaks.
const falseAlarms = perItem.filter((x) => x.it.label === "works" && x.saidBroken > 0).sort((a, b) => b.saidBroken - a.saidBroken);
if (!falseAlarms.length) say("No model said any working item breaks.");
else say(table(["Item", "Intent", "Models that said it breaks", "Their answers"],
  falseAlarms.map((x) => [tick(x.it.item_id), short(x.it.intent), `${x.saidBroken}/${n}`, describeTally(x.tally)])));
say();

say("## 5. Items most models got wrong");
say();
const hard = perItem.filter((x) => x.wrong >= Math.max(1, Math.ceil(n * 0.75))).sort((a, b) => b.wrong - a.wrong);
if (!hard.length) say("No item was missed by three quarters of the models.");
for (const x of hard) {
  say(`### ${tick(x.it.item_id)} — missed by ${x.wrong}/${n}`);
  say();
  say(`- **Intent:** ${oneLine(x.it.intent)}`);
  say(`- **Windows actually:** \`${x.it.label}\`${x.it.evidence ? ` — printed: ${tick(short(oneLine(x.it.evidence), 160))}` : ""}`);
  say(`- **Models said:** ${describeTally(x.tally)}`);
  say(`- **Code:**`);
  say();
  say("```" + (x.it.kind === "npm" ? "sh" : "js"));
  say(x.it.code);
  say("```");
  say();
}

say("## 6. Every item, every model");
say();
say("Rows are items, columns are models in leaderboard order; ✓ = correct, otherwise the wrong answer.");
say();
const abbrev = { works: "works", fails_loudly: "loud", fails_silently: "silent", unparseable: "?", error: "err", missing: "–" };
say(table(["Item", "Windows", ...models.map((_, i) => `#${i + 1}`)],
  perItem.map((x) => [tick(x.it.item_id), x.it.label,
    ...models.map((m) => { const p = m.predictions[x.it.item_id] || "missing"; return p === x.it.label ? "✓" : abbrev[p] || p; })])));
say();

const md = out.join("\n");
if (outFile) {
  fs.writeFileSync(outFile, md);
  console.error(`wrote ${outFile} (${n} models)`);
} else {
  process.stdout.write(md);
}
