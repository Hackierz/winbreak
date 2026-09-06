# winbreak

[![test](https://github.com/Hackierz/winbreak/actions/workflows/test.yml/badge.svg)](https://github.com/Hackierz/winbreak/actions/workflows/test.yml)

Finds the code in a Node project that works on macOS and Linux and breaks on Windows.

No dependencies. No config. One command.

```bash
npx github:Hackierz/winbreak
```

> Not on npm yet, so run it straight from this repo — that command works today
> and needs nothing installed. Once it is published, `npx winbreak` will do the
> same thing.

## Or use the browser: paste code, or name any npm package

**https://opusmill.com/check** — no install, no account.

Paste a snippet, or type a package name and it will scan the published
package. That runs entirely in your tab: the npm registry allows cross-origin
fetches and browsers can gunzip, so the tarball goes from npm straight into
the page, where a small tar reader unpacks it. **eslint's 409 files scan in
about a second.** There is no server of mine involved, and nothing you paste
leaves your machine.

`/check?pkg=express` scans on load, so a result is a shareable link.

It runs `lib/rules.js` and `lib/core.js` inlined verbatim by
`scripts/build-web.js`, so the page reports exactly what the CLI reports —
verified against pmx, agent-cli-detector, chalk and eslint. The test suite
fails if that bundle goes stale.

Use the browser for one snippet or one package. Use the CLI for your own
repository, or for CI.

## Why this exists

In September 2026 I tried to install Coinbase's own Agentic Wallet on a
Windows machine. It failed four separate times, in four different ways, and
every failure was invisible on macOS:

1. The installer reported **"Node.js is not available"** on a machine with Node
   installed. It spawned `process.execPath` with `shell: true`, and cmd.exe
   split `C:\Program Files\nodejs\node.exe` at the space.
2. The launcher spawned `node_modules/.bin/electron` — a POSIX shell script.
   **ENOENT.**
3. The CLI spawned `electron.cmd` without `shell: true`. **EINVAL.**
4. The wallet validated callers with `ps -p <pid> -o command=`, which does not
   exist on Windows. `execSync` threw, a `catch` swallowed it, and every
   request was silently rejected. The CLI then hung for its full 180-second
   timeout with no error at all.

None of these are exotic. They are the same four mistakes, made over and over,
in software written by people who only ever ran it on a Mac.

So: a checker that looks for exactly those mistakes.

## It finds real bugs

Run against Coinbase's shipped `awal` CLI, v2.12.1, straight from npm:

```
$ npx github:Hackierz/winbreak node_modules/awal/dist

dist/ipcClient.js
     25  Hardcoded POSIX directory                    hardcoded-posix-path
         const ipcDir = '/tmp/payments-mcp-ui-bridge';

dist/utils/processCheck.js
      4  Hardcoded POSIX directory                    hardcoded-posix-path
         const LOCK_FILE = '/tmp/payments-mcp-ui.lock';

dist/utils/serverManager.js
     70  `rm -rf` used to delete a directory          case-sensitive-rm
         execSync(`rm -rf "${bundleDir}"`, { stdio: 'pipe' });

3 bugs in 68 files
```

All three are genuine. `/tmp` on Windows silently becomes `C:\tmp`, and `rm`
does not exist, so that delete quietly does nothing.

## I scanned the 600 most-downloaded CLI packages

Latest published tarballs, ranked by real weekly downloads from the npm
downloads API, scanned with `--include-build` because in a published package
`dist/` is the product.

    599 packages   33,402 source files

    JavaScript          npm scripts
     18  ( 3.0%)        104  (17.4%)   at least one finding
     48  findings       214  findings

**Then I read all 48 JavaScript findings by hand, and that is the part that
matters:**

- **3 are real.** `agent-cli-detector` (4.5M downloads/week) accounts for two:
  `execFileSync("ps", …)` in a `try/catch` returning `""`, in a 326-line file
  with **no mention of platform, win32, darwin or linux anywhere**. On Windows
  its whole process-tree detection silently finds nothing. The third is `pmx`:
  `execFile('npm.cmd', …)` with no `shell`, and a callback that does
  `if (error) return`, so it quietly collects nothing on Windows, forever.
- **38 are deliberately Linux-only.** pm2 writing `/etc/init.d` because its
  startup feature *is* Linux. oclif running `ln -s` and `sudo chown` in
  `pack/deb.js`, which builds a Debian package. vite reading `/etc/wsl.conf`
  to detect WSL. **A checker that reads text cannot see intent**, and
  pretending otherwise is how a tool stops being trusted. `// winbreak-ignore`
  exists for exactly this.
- **7 were winbreak being wrong.** That is a **15% false-positive rate on
  findings**, and I would rather print it than have you discover it.

`winbreak --fix` repairs **125 of those 214 findings (58%) automatically** --
I measured it by running the fixer over every finding in the survey. The rest
are `cp`, `mkdir -p`, `$npm_package_config_*`, docker invocations and shell
programs, and it says so rather than guessing.

**The npm scripts are the more interesting half.** 104 of 599 packages
(17.4%) have a `package.json` script that cannot run on Windows -- roughly six
times the JavaScript rate. `rm -rf dist`, `NODE_ENV=test node --test`,
`for FILE in test/*.js; do ...`. I read 28 of the 214 in full (the top twelve
by downloads plus sixteen at random) and **all 28 were genuine**, because an
npm script has no enclosing `if (process.platform === 'win32')` to misread.

But the honest reading is narrower than the number looks: npm runs a package's
own scripts on your machine only at install time, and **exactly two of the 214
are install-time scripts**. The rest are `build`, `test` and `clean`. So one in
six of these packages ships fine to Windows users and cannot be *contributed
to* from Windows without fixing the build first -- a cost paid silently by
people who never became contributors.

**I first published "11 are real" and had to correct it to 3.** Four findings
I had called real turned out to be guarded — three of them in a *different
function* than the call, which a one-file text scanner cannot see. That
correction is written up rather than quietly edited out.

Full write-up: **https://opusmill.com/600-packages**
Every result, searchable: **https://opusmill.com/packages**

### The survey's real yield was seven bugs in winbreak

1. **`whoami` was in the POSIX-only list.** It ships with Windows, and has
   since Vista. *"This is a Unix command" is not "Windows does not have it"* —
   Windows also has `find`, `sort`, `more`, `where`, `tasklist`, `taskkill`.
2. **Guard detection did not understand a platform name.** `if (os === 'linux')`
   was invisible, so correctly guarded code was reported.
3. **And the first fix still failed**, because `enclosingBlock` recorded the
   string-stripped line and the guard arrived as `if (os === '')`.
4. **A single-line early return is a guard** — `if (win32) return;` encloses
   nothing.
5. **So is the block form** — `if (win32) { …; return }` above the call.
6. **Handing a `.cmd` to `cmd.exe` was reported as a bug.** That is the fix.
7. **`rm -rf` matched anywhere in 2,000 characters** of extracted call text,
   catching a `console.log` of advice meant for a human to read.

Findings on minified lines are suppressed too: Next.js ships `cross-spawn` on
one line and it was reported as a `.cmd` spawning bug — cross-spawn being the
library that exists to fix `.cmd` spawning.

Every one of these is a regression test in `test/fixtures/`.

### What it still cannot do

**Cross-function analysis.** If the platform check lives in the caller and the
POSIX-only call lives in a helper, winbreak reports the helper. Three of the
seven false positives above are exactly this shape. Reading one file at a time
is the design, and this is the cost of it.

## Bugs and smells

Findings come in two weights:

- **bug** — this fails at runtime on Windows. Exits `1`.
- **smell** — this works, but it is fragile, or it is the habit that produces
  the bugs. Reported, but **never fails your build**. Use `--strict` if you
  want it to.

Failing someone's pipeline over a style opinion is how a tool gets deleted from
the pipeline.

## Usage

```bash
winbreak                 # scan the current directory
winbreak src             # scan a directory
winbreak lib/thing.js    # scan one file
winbreak --json          # machine-readable
winbreak --rules         # what it looks for, and why
winbreak --include-build # also scan dist/ build/ out/
winbreak --fix           # repair the npm scripts that have one obvious fix
winbreak --fix --dry-run # ...show the changes and write nothing
winbreak --github        # annotate the PR diff (GitHub Actions)
```

### `--fix`

It rewrites **only** the `scripts` block of a `package.json`, and **only** the
two problems the ecosystem has already agreed an answer to:

```
- "clean": "rm -rf dist"
+ "clean": "rimraf dist"

- "build": "rm -rf dist && NODE_ENV=production rollup -c"
+ "build": "rimraf dist && cross-env NODE_ENV=production rollup -c"
```

Everything else it **refuses, by name**:

```
left alone, because these need a real script file:
  package.json  "examples"  (a shell loop or conditional)
    for FILE in example/*.js; do node $FILE; done
```

A `for` loop, `$(...)`, `${VAR/a/b}` or a pipe into `sed` is a shell program.
There is no mechanical translation of one into something cmd.exe runs, and
guessing would edit a build script in a way that fails later and elsewhere.
Move those into a `.mjs` file and call it with `node`, which runs anywhere.

Three things it will not do: reformat your file (only the changed *values* are
rewritten, so the diff is the lines that changed), write anything that is not
valid JSON (it reparses before saving and refuses if it broke something), or
run `npm install` for you. It prints the install line and leaves it to you.

Running it twice changes nothing the second time.

Read `winbreak` above as `npx github:Hackierz/winbreak` until it is on npm.

`dist/`, `build/` and `out/` are skipped by default, because in a source repo
they are generated and you would get every finding twice. It always tells you
how many files that hid. In a package downloaded from npm they are the whole
product, so use `--include-build` there.

## In CI, on the pull request diff

```yaml
- uses: Hackierz/winbreak@main
```

That is the whole thing. No install step and no `setup-node` -- winbreak has no
dependencies and every GitHub runner ships Node. Findings appear **as
annotations on the changed lines**, with the reason and the fix, plus a job
summary.

The point of annotating rather than printing: a log line saying "3 bugs" is
something a reviewer has to go looking for, and code review is the last moment
a Windows bug is cheap to fix.

On an existing codebase that has never been checked, start without blocking:

```yaml
- uses: Hackierz/winbreak@main
  with:
    fail-on-findings: "false"   # annotate, do not block the merge
```

| Input | Default | |
|---|---|---|
| `path` | `.` | what to scan |
| `fail-on-findings` | `true` | fail the job on a bug |
| `strict` | `false` | also fail on smells |
| `include-build` | `false` | also scan `dist/`, `build/`, `out/` |
| `include-tests` | `false` | also scan test files |

Outputs `findings`, `bugs`, `smells`, `files` and `fixable`, so a workflow can
branch on the result without re-reading the log:

```yaml
- uses: Hackierz/winbreak@main
  id: wb
  with: { fail-on-findings: "false" }
- run: echo "${{ steps.wb.outputs.fixable }} of these are one command away"
```

The action runs against this repository on every push, on Ubuntu **and
Windows**, because the composite step is bash and bash on a Windows runner is
Git Bash -- which is not the same shell, and is exactly the class of difference
this tool exists to find.

Exit code is `1` when a **bug** is found, so it drops straight into CI:

```yaml
- run: npx github:Hackierz/winbreak
```

Use `--no-exit-code` if you want a report without failing the build.

### Silencing a finding

```js
const p = "/tmp/scratch";           // winbreak-ignore
// winbreak-ignore-next
const q = "/tmp/other";
```

## The rules

| id | catches |
|---|---|
| `spawn-cmd-no-shell` | spawning a `.cmd` or `.bat` without `shell: true` → EINVAL |
| `spawn-bin-shim` | spawning an extensionless `node_modules/.bin/*` → ENOENT |
| `posix-only-command` | shelling out to `ps`, `which`, `chmod`, `uname` … with no platform guard |
| `hardcoded-posix-path` | `/tmp`, `/usr`, `/etc`, `/home` … written as a literal |
| `shell-true-unquoted-path` | `shell: true` with a path that can contain spaces |
| `posix-path-concat` | building a path with `+ "/"` instead of `path.join` *(smell)* |
| `case-sensitive-rm` | `rm -rf` used to delete a directory |

`winbreak --rules` prints the reasoning and the fix for each.

## What it misses

Being honest about this matters more than the feature list.

**It is a heuristic scanner, not a type checker.** It reads text. It does not
build a syntax tree and it does not follow your program's control flow.

Specifically:

- **It follows variables one hop.** `const npmCmd = ... ".cmd"` then
  `spawn(npmCmd, …)` is caught. A value that travels through a returned object
  and a destructure before reaching the spawn is not. Coinbase's `serverManager`
  has exactly that shape and winbreak does not flag it.
- **Test files are skipped by default**, because fixtures are full of
  deliberate POSIX paths. Pass `--include-tests` to scan them.
- **Files over 2 MB are skipped**, on the assumption they are bundles.
- **A clean run is not a promise.** It means these seven patterns were not
  found. It does not mean your code runs on Windows.

The right way to know your code works on Windows is to run it on Windows.
This just finds the four mistakes everybody makes before you get that far.

## Contributing

Found a Windows bug shape that is not here? Open an issue with the smallest
piece of real code that breaks, and what it does on Windows. Rules earn their
place by having caused a real failure, not by being theoretically possible.

Every rule ships with two fixtures: one where it must fire, one of correct code
where it must not. `npm test` runs both. A false positive is treated as a bug
of equal weight to a miss — a checker that cries wolf gets uninstalled after
one run.

## Tested where it matters

The suite runs on **Windows, macOS and Linux**, across Node 18, 20 and 22 —
nine jobs, all required to pass. A tool that claims to find Windows bugs has
no business being tested only on Linux.

CI also asserts the CLI exits non-zero on the broken fixture. A checker that
exits 0 on bad code passes your pipeline while lying to you, which is worse
than having no checker at all.

## Licence

MIT. Made by [OpusMill](https://opusmill.com).
