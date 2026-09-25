# %% [markdown]
# # Works on My Mac
#
# **Can a model predict what Node.js code does on Windows, when every answer
# was produced by actually running the code there?**
#
# Each item is a short npm script or Node.js program that works on a Mac,
# plus a plain statement of what its author intended. The model predicts what
# happens on a stock Windows install with Node.js 24 and npm 11:
#
# - `works` -- exits 0 and does what the author intended
# - `fails_loudly` -- non-zero exit, crash or uncaught error
# - `fails_silently` -- exits 0, but does **not** do what was intended
#
# **The labels were not written by hand.** A harness ran every item on
# macOS, Linux and two different Windows machines, with Windows' PATH reduced
# to a stock install (Git for Windows puts `rm`, `cp`, `grep` and `ls` on PATH,
# on developer machines *and* on GitHub's Windows runners, which would make
# `rm -rf` "work"). An item is included only if it works on macOS and both
# Windows machines agree. Harness, raw results and exclusions:
# https://github.com/Hackierz/winbreak/tree/main/bench
#
# The hypothesis: famous error strings (`'NODE_ENV' is not recognized`) are
# memorised; failures that exit 0 are not. The score is **balanced accuracy**
# over the three outcomes, so answering "it breaks" to everything scores 1/3.

# %%
import json
import random
from dataclasses import dataclass

import pandas as pd

import kaggle_benchmarks as kbench

# %%
DATASET = json.loads(r'''__DATASET_JSON__''')
df = pd.DataFrame(DATASET["items"])
print(len(df), "items;", df.label.value_counts().to_dict())

# %%
OUTCOMES = ("works", "fails_loudly", "fails_silently")

HOW_RUN = {
    "npm": "It is an npm script named `t` in package.json, run with `npm run t`. "
           "package.json has name \"bench-fixture\" and version \"1.0.0\", and "
           "cross-env, rimraf and shx are installed in node_modules.",
    "node": "It is saved as main.js (CommonJS) and run with `node main.js`.",
    "esm": "It is saved as main.mjs (an ES module) and run with `node main.mjs`.",
}

PROMPT = """A developer wrote the code below on a Mac and tested it only there. On their Mac it works: it exits successfully and does exactly what they intended.

Predict what happens when the same code runs on Windows 11 -- a fresh install with only Node.js 24 and npm 11 added, default settings, run from the directory described below.

How it is run: {how}
Other files already in the directory: {files}
What the author intended: {intent}

{code_label}:
```
{code}
```

Choose exactly one outcome:
- works: exits with code 0 AND does what the author intended.
- fails_loudly: exits with a non-zero code, crashes, or throws an uncaught error.
- fails_silently: exits with code 0, but does NOT do what the author intended.

Give the outcome and one sentence explaining why."""


def render(kind, intent, code, files):
    if files:
        listed = "; ".join(f"{name} (contents: {body!r})" for name, body in files.items())
    else:
        listed = "none"
    return PROMPT.format(
        how=HOW_RUN[kind],
        files=listed,
        intent=intent,
        code_label="The script" if kind == "npm" else "The code",
        code=code,
    )


@dataclass
class Verdict:
    outcome: str
    reason: str


def normalise(raw) -> str:
    t = str(raw or "").strip().lower().replace("-", "_").replace(" ", "_")
    if t in OUTCOMES:
        return t
    if "silent" in t:
        return "fails_silently"
    if "loud" in t or "error" in t or "crash" in t:
        return "fails_loudly"
    if t.startswith("work") or t in ("succeeds", "success", "ok"):
        return "works"
    return "unparseable"


# %%
@kbench.task(name="womm_item", store_task=False)
def womm_item(llm, item_id, kind, intent, code, files, label) -> dict:
    try:
        verdict = llm.prompt(render(kind, intent, code, files), schema=Verdict)
        predicted, reason = normalise(verdict.outcome), str(verdict.reason)
    except Exception as e:  # a model that cannot answer gets the item wrong
        predicted, reason = "unparseable", f"{type(e).__name__}: {e}"
    return {
        "item_id": item_id,
        "label": label,
        "predicted": predicted,
        "correct": predicted == label,
        "reason": reason[:300],
    }


def balanced_accuracy(rows) -> float:
    recalls = []
    for outcome in OUTCOMES:
        in_class = [r for r in rows if r["label"] == outcome]
        if in_class:
            recalls.append(sum(r["correct"] for r in in_class) / len(in_class))
    return sum(recalls) / len(recalls) if recalls else 0.0


def breakdown(rows) -> dict:
    out = {"n": len(rows), "balanced_accuracy": balanced_accuracy(rows),
           "accuracy": sum(r["correct"] for r in rows) / len(rows) if rows else 0.0,
           "unparseable": sum(r["predicted"] == "unparseable" for r in rows)}
    for outcome in OUTCOMES:
        in_class = [r for r in rows if r["label"] == outcome]
        out[f"recall_{outcome}"] = (sum(r["correct"] for r in in_class) / len(in_class)) if in_class else None
    # Right that it breaks, wrong about how: the gap between memorised error
    # strings and understanding what the code does.
    broken = [r for r in rows if r["label"] != "works"]
    out["broken_detected"] = (sum(r["predicted"].startswith("fails") for r in broken) / len(broken)) if broken else None
    out["wrong_failure_mode"] = sum(
        r["predicted"].startswith("fails") and r["predicted"] != r["label"] for r in broken)
    out["confusion"] = {
        lab: {pred: sum(r["label"] == lab and r["predicted"] == pred for r in rows)
              for pred in OUTCOMES + ("unparseable",)}
        for lab in OUTCOMES}
    out["wrong_items"] = sorted(r["item_id"] for r in rows if not r["correct"])
    return out


def bootstrap_halfwidth(rows, n=1000, seed=0) -> float:
    rng = random.Random(seed)
    stats = sorted(balanced_accuracy([rng.choice(rows) for _ in rows]) for _ in range(n))
    return (stats[int(0.975 * n) - 1] - stats[int(0.025 * n)]) / 2


# %%
@kbench.task(name="works_on_my_mac")
def works_on_my_mac(llm) -> tuple[float, float]:
    with kbench.client.enable_cache():
        runs = womm_item.evaluate(
            llm=[llm],
            evaluation_data=df,
            on_failure="continue",
            max_attempts=2,
            retry_delay=10,
            n_jobs=4,
            timeout=180,
        )
    rows = [dict(r) for r in runs.completed_runs.as_dataframe().result]
    # Runs that never completed count as wrong, not as missing: dropping them
    # would quietly raise the model's score.
    done = {r["item_id"] for r in rows}
    for item in DATASET["items"]:
        if item["item_id"] not in done:
            rows.append({"item_id": item["item_id"], "label": item["label"],
                         "predicted": "unparseable", "correct": False, "reason": "run failed"})
    result = breakdown(rows)
    print("WOMM_BREAKDOWN " + json.dumps(result, sort_keys=True))
    return result["balanced_accuracy"], bootstrap_halfwidth(rows)


# %%
run = works_on_my_mac.run(kbench.llm)
run

# %%
%choose works_on_my_mac
