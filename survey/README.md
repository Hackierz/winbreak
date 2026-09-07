# The survey harness

This is the code behind
[opusmill.com/600-packages](https://opusmill.com/600-packages) — the scan of
the 600 most-downloaded npm CLI packages that produced these numbers:

```
599 packages   33,402 source files

JavaScript          npm scripts
 18  ( 3.0%)        104  (17.4%)   at least one finding
 48  findings       214  findings
```

It is here so the claim can be checked rather than believed. I have already
had to correct that write-up three times in public; the corrections are only
worth anything if someone else can reach the same numbers independently.

## Running it

Needs Python 3 and Node. From this directory:

```bash
python run_survey.py 600
```

That downloads each package's published tarball, extracts it, scans it with
the checker in `../lib`, appends one JSON line per package to
`results.jsonl`, and deletes the extracted files before the next batch. It
resumes: run it again and it skips whatever is already in `results.jsonl`.

Expect it to take 15–30 minutes and a few hundred MB of transient disk. It
never writes outside its own working directory.

## Why `ranked.tsv` is checked in

**Without it you would be scanning a different sample and could not reproduce
anything.** It is the exact ordered list I used: packages tagged `cli`,
`devtools`, `build-tool`, `scaffold`, `generator` and `process` in the npm
registry (1,417 unique names), ranked by real weekly downloads from the npm
downloads API.

Ranked by *real download counts*, not by the registry's own `popularity`
score — that returns an identical value for every package and is useless for
ordering. If you re-rank today you will get a slightly different list, because
download counts move. That is the point of pinning the file.

## Two failure modes this harness has already had

Both produced a results file that looked fine and was quietly incomplete, so
they are worth knowing about if you adapt it:

1. **`subprocess.run(..., text=True)` decodes with the locale codec.** On
   Windows that is cp1252, and one package in 600 contains a byte cp1252
   cannot map. The `UnicodeDecodeError` fired *before* the returncode check,
   and the handler logged a line and carried on — **twenty packages silently
   missing.** Fixed with an explicit `encoding="utf-8", errors="replace"`.

2. **An exception handler around data collection that only logs.** Same
   shape, different cause. Both now `sys.exit(1)`.

The rule both taught: **a survey that loses rows without saying so is worse
than one that stops.**

## Is a tarball a fair proxy for the repository?

The harness reads **published tarballs**; the person this bug hurts has cloned
the **repository**. Tools like `clean-publish` can strip the `scripts` block on
publish, which would mean measuring the wrong artefact.

Checked twenty packages, tarball scripts vs the repository's `package.json` on
its default branch: **0 stripped**, 15 of 19 identical, 4 differing by a few
keys in both directions (release drift — the tarball is a released version and
`main` has moved on), 1 not comparable (monorepo, no root `package.json`).

Nobody stripped anything, so the published scripts block is a fair proxy.

## Known limitation: no scoped packages

**`ranked.tsv` contains zero `@scope/name` packages** — none, out of all 1,412
names the keyword search returned. That is a property of how the list was
gathered, not a deliberate filter, and scoped packages are a large part of
modern npm.

Measured rather than left hanging: 34 scoped CLI/build-tooling packages scanned
the same way gave **14.7% with a hostile npm script (5 of 34, 95% CI
6.4–30.1%)** against 17.4% (14.5–20.6%) here. The intervals overlap heavily, so
there is no evidence the omission moved the headline — but 34 is a small,
hand-picked sample, so treat it as reassurance rather than proof.

If you want to extend the survey properly, this is the obvious place to start:
build a scoped `ranked.tsv` and re-run.

## The hand classification is not here

`results.jsonl` is raw output. Turning 48 JavaScript findings into "3 real,
38 deliberately Linux-only, 7 my own false positives" took reading every one
in context, and that judgement is written up in the article rather than
encoded here. You should expect to disagree with some of it — the article
names every package and line so you can.
