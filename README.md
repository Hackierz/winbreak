# winbreak

Finds the code in a Node project that works on macOS and Linux and breaks on Windows.

No dependencies. No config. One command.

```bash
npx winbreak
```

## Why this exists

On 6 September 2026 I tried to install Coinbase's own Agentic Wallet on a
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
$ npx winbreak node_modules/awal/dist

dist/ipcClient.js
     25  Hardcoded POSIX directory                    hardcoded-posix-path
         const ipcDir = '/tmp/payments-mcp-ui-bridge';

dist/utils/processCheck.js
      4  Hardcoded POSIX directory                    hardcoded-posix-path
         const LOCK_FILE = '/tmp/payments-mcp-ui.lock';

dist/utils/serverManager.js
     70  `rm -rf` used to delete a directory          case-sensitive-rm
         execSync(`rm -rf "${bundleDir}"`, { stdio: 'pipe' });

3 findings across 2 rules in 82 files
```

All three are genuine. `/tmp` on Windows silently becomes `C:\tmp`, and `rm`
does not exist, so that delete quietly does nothing.

## Usage

```bash
npx winbreak                 # scan the current directory
npx winbreak src             # scan a directory
npx winbreak lib/thing.js    # scan one file
npx winbreak --json          # machine-readable
npx winbreak --rules         # what it looks for, and why
```

Exit code is `1` when anything is found, so it drops straight into CI:

```yaml
- run: npx winbreak
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
| `posix-path-concat` | building a path with `+ "/"` instead of `path.join` |
| `case-sensitive-rm` | `rm -rf` used to delete a directory |

`npx winbreak --rules` prints the reasoning and the fix for each.

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

## Licence

MIT. Made by [Evan Bo](https://opusmill.com) at OpusMill.
