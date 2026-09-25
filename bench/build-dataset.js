#!/usr/bin/env node
// Turn raw measurements into benchmark labels, then emit the Kaggle notebook.
//
//   node bench/build-dataset.js
//
// Reads bench/results/*.json (from measure.js on each machine) and applies the
// inclusion rules mechanically:
//
//   1. The item must WORK on macOS. It is "works on my Mac" code; if it is
//      broken on the Mac too, it is just broken code.
//   2. Both Windows machines, measured as stock installs (--clean-env), must
//      AGREE. The label is that shared outcome. If they disagree, the answer
//      depends on how the machine is configured, which no model can know --
//      the item is excluded and the disagreement reported.
//
// Nothing is labelled by hand, and every exclusion is written down.
"use strict";

const fs = require("fs");
const path = require("path");

const items = require("./fixtures/items");
const benchDir = __dirname;
const resultsDir = path.join(benchDir, "results");

function load(name) {
  const f = path.join(resultsDir, name);
  if (!fs.existsSync(f)) {
    console.error(`missing ${path.relative(process.cwd(), f)}: download the bench workflow's artifacts first`);
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  return { env: data.env, by: Object.fromEntries(data.results.map((r) => [r.id, r])) };
}

const R = {
  mac: load("darwin-ci.json"),
  linux: load("linux-ci.json"),
  winLocal: load("win32-local-clean.json"),
  winCi: load("win32-ci-clean.json"),
  winLocalAsIs: load("win32-local.json"),
  winCiAsIs: load("win32-ci.json"),
};

const scored = [];
const excluded = [];
const gitEffect = [];

for (const item of items) {
  const o = Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v.by[item.id] && v.by[item.id].outcome]));
  if (Object.values(o).some((x) => !x)) {
    excluded.push({ item_id: item.id, reason: "not measured on every machine", outcomes: o });
    continue;
  }
  // How much the developer's own Windows set-up changes the answer.
  if (o.winLocalAsIs !== o.winLocal || o.winCiAsIs !== o.winCi) {
    gitEffect.push({ item_id: item.id, stock: o.winLocal, local_as_is: o.winLocalAsIs, ci_as_is: o.winCiAsIs });
  }
  if (o.mac !== "works") {
    excluded.push({ item_id: item.id, reason: "does not work on macOS", outcomes: o });
    continue;
  }
  if (o.winLocal !== o.winCi) {
    excluded.push({
      item_id: item.id,
      reason: "the two stock Windows machines disagree",
      outcomes: o,
      evidence: { local: R.winLocal.by[item.id].err || R.winLocal.by[item.id].out,
                  ci: R.winCi.by[item.id].err || R.winCi.by[item.id].out },
    });
    continue;
  }
  scored.push({
    item_id: item.id,
    kind: item.kind,
    intent: item.intent,
    code: item.kind === "npm" ? item.script : item.code,
    files: item.files,
    label: o.winLocal,
    linux: o.linux,
    // What Windows actually printed. Not shown to the model; kept so every
    // label can be checked by a human.
    evidence: (R.winLocal.by[item.id].err || R.winLocal.by[item.id].out || "").slice(0, 200),
  });
}

const counts = scored.reduce((t, s) => ((t[s.label] = (t[s.label] || 0) + 1), t), {});
const machines = Object.fromEntries(Object.entries(R).map(([k, v]) => [k, {
  platform: v.env.platform, release: v.env.release, node: v.env.node, npm: v.env.npm,
  cleanEnv: Boolean(v.env.cleanEnv), measuredAt: v.env.measuredAt,
}]));

const dataset = {
  name: "Works on My Mac",
  version: 1,
  protocol: "Labels are measured, not written. Included only if the item works on macOS and two stock-configured Windows machines agree. See bench/build-dataset.js.",
  machines,
  counts: { scored: scored.length, excluded: excluded.length, ...counts },
  items: scored,
  excluded,
  git_for_windows_effect: gitEffect,
};
fs.writeFileSync(path.join(benchDir, "dataset.json"), JSON.stringify(dataset, null, 2) + "\n");

// ---- the Kaggle notebook, with the dataset embedded (no upload step) ------
const forModel = { items: scored.map(({ item_id, kind, intent, code, files, label }) =>
  ({ item_id, kind, intent, code, files, label })) };
const json = JSON.stringify(forModel);
if (json.includes("'''")) throw new Error("dataset contains ''' and would break the raw string");

const template = fs.readFileSync(path.join(benchDir, "kaggle", "notebook_template.py"), "utf8");
if (!template.includes("__DATASET_JSON__")) throw new Error("template placeholder missing");
const script = template.replace("__DATASET_JSON__", () => json);
fs.writeFileSync(path.join(benchDir, "kaggle", "works_on_my_mac.py"), script);

// Same cells as an .ipynb, for File > Import Notebook on Kaggle.
const cells = [];
for (const block of script.split(/^# %%/m).slice(1)) {
  const nl = block.indexOf("\n");
  const header = block.slice(0, nl);
  let body = block.slice(nl + 1).replace(/\s+$/, "");
  const markdown = header.includes("[markdown]");
  if (markdown) body = body.split("\n").map((l) => l.replace(/^# ?/, "")).join("\n");
  const lines = body.split("\n");
  const source = lines.map((l, i) => (i < lines.length - 1 ? l + "\n" : l));
  cells.push(markdown
    ? { cell_type: "markdown", metadata: {}, source }
    : { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source });
}
fs.writeFileSync(path.join(benchDir, "kaggle", "works_on_my_mac.ipynb"), JSON.stringify({
  cells,
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    language_info: { name: "python" },
  },
  nbformat: 4,
  nbformat_minor: 5,
}, null, 1) + "\n");

console.log(`scored ${scored.length}:`, JSON.stringify(counts));
console.log(`excluded ${excluded.length}:`);
for (const e of excluded) console.log(`  ${e.item_id.padEnd(28)} ${e.reason}`);
console.log(`Git-for-Windows effect: ${gitEffect.length} items change outcome between a stock install and a real machine`);
console.log(`wrote dataset.json, kaggle/works_on_my_mac.py (${script.length} bytes), kaggle/works_on_my_mac.ipynb (${cells.length} cells)`);
