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

## I scanned 25 popular CLI packages

Latest published tarballs, straight from npm, scanned with `--include-build`
because in a published package `dist/` is the product. Reproduce it exactly:

```bash
npm pack nodemon pm2 mocha eslint prettier typescript rimraf npm-check-updates \
  concurrently husky lint-staged jest webpack rollup vite esbuild ts-node nx \
  lerna serve http-server json-server nodegit degit plop
# extract each, then:
npx github:Hackierz/winbreak <pkg>/package --include-build
```

    21 of 25  no bugs
     4 of 25  with findings

**And I do not claim all four are real bugs.** Here is every one:

- **pm2** — 19. pm2 *generates* systemd and init.d scripts, so `/etc/init.d`
  and `/proc/meminfo` are correct inside a deliberately Linux-only code path.
- **npm-check-updates** — 3, all from a bundled XDG helper falling back to
  `/usr/local/share` when `$XDG_DATA_DIRS` is unset. On Windows it is unset.
  Arguably real, arguably how that library is meant to work. Your call.
- **nx** — 2, both Linux detection (`readFileSync('/usr/bin/ldd')` to sniff
  musl). The read is expected to fail elsewhere.
- **vite** — 2, `/etc/wsl.conf` and an `/opt` constant, both environment
  detection.

So the honest summary is: **21 clean, 4 with findings that are mostly
intentional Linux-only code.** winbreak reads text, not intent. That is the
limitation, `// winbreak-ignore` exists for exactly this, and hiding it behind
a nicer number would make the tool worth less, not more.

The takeaway is still the useful one: mature packages are mostly fine. A tool
that lit up on all 25 would be a tool with a broken threshold.

### What this survey cost me

Running it found four bugs in **winbreak**, not in the packages:

1. **nodemon's two "bugs" were mine.** `exec(\`kill -${sig} ${pid}\`)` sits in
   the `else` half of `if (utils.isWindows) { … } else { … }`, and the branch
   is 87 lines up. Guard detection used a ±6-line window and could not see it.
   It walks the enclosing braces now, and follows an `else` back to its `if`.
   This claim had already been written into this README as fact.
2. **`dist/` was skipped silently.** Correct for a source repo, badly wrong for
   a downloaded package — it reported "1 bug in 2 files" for a 43-file package.
   Still skipped by default, but the count is now printed, and
   `--include-build` scans it.
3. **`hardcoded-posix-path` had no guard detection at all.** It flagged
   `x !== "/usr/bin/esbuild"` (a comparison), `/proc/version` (WSL detection)
   and the POSIX side of a `process.platform === "win32"` ternary.
4. **`.d.ts` files were scanned.** They are declarations. Nothing in them runs.

Each has a regression test in `test/run.js`.

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
```

Read `winbreak` above as `npx github:Hackierz/winbreak` until it is on npm.

`dist/`, `build/` and `out/` are skipped by default, because in a source repo
they are generated and you would get every finding twice. It always tells you
how many files that hid. In a package downloaded from npm they are the whole
product, so use `--include-build` there.

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
