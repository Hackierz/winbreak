"use strict";

/**
 * The rules.
 *
 * Every one of these came from a bug that actually shipped. None of them are
 * hypothetical. The comments name the real failure so you can tell whether the
 * finding matters to you.
 *
 * A rule is:
 *   id     stable slug, used in --json and in ignore comments
 *   title  one line, what is wrong
 *   why    what actually happens at runtime on Windows
 *   fix    what to do instead
 *   scope  "call"  -> tested against an extracted call expression
 *          "line"  -> tested against a single source line
 *   test   (text, ctx) => boolean
 */

/** Commands that simply do not exist on a stock Windows install. */
const POSIX_ONLY = [
  "ps", "which", "uname", "chmod", "chown", "ln", "df", "du",
  "id", "kill", "pkill", "killall", "sed", "awk", "grep",
  "readlink", "dirname", "basename", "mktemp", "touch", "sudo",
];

/*
 * `whoami` was in the list above and should not have been. It ships with
 * Windows and has since Vista -- `whoami.exe` lives in System32. Surveying 600
 * packages reported `exec('whoami')` in pm2 and bugsnag-build-reporter as
 * bugs, and both are perfectly fine on Windows.
 *
 * Worth stating the general trap: "this is a Unix command" is not the same as
 * "Windows does not have it". Windows also has `find`, `sort`, `more`, `echo`,
 * `where` (the `which` equivalent), `tasklist` and `taskkill`.
 */

/**
 * Directories that exist on POSIX and not on Windows.
 *
 * `/dev` is deliberately NOT here. `/dev/null` appears in git diff output on
 * every platform including Windows, so `x === "/dev/null"` is correct code,
 * not a bug. Scanning mocha turned up three of those and zero real ones.
 *
 * `/proc` is not here either, for the same reason. Reading `/proc/version` or
 * `/proc/self/cgroup` is the standard way to ask "am I in WSL or Docker?" —
 * the read is expected to fail off Linux and the caller wraps it. vite does
 * exactly this three times and every one was a false positive.
 */
const POSIX_DIRS = ["/tmp", "/usr", "/etc", "/var", "/home", "/opt", "/root"]; // winbreak-ignore

/**
 * Severity.
 *
 *   "bug"    this fails at runtime on Windows
 *   "smell"  this works, but it is fragile or hides a real one
 *
 * Only bugs set a non-zero exit code, so a smell can never break someone's
 * build over a style opinion. `--strict` opts into failing on both.
 */

/**
 * True when this code already sits inside a platform branch.
 *
 * Checked against a wide look-back, not the display context. The usual shape
 * is `if (isWindows) { … } else { …POSIX-only code… }` wrapping an entire
 * function, so the branch can be a hundred lines above the call. A narrow
 * window reported nodemon's correct POSIX-only kill path as two bugs.
 *
 * This trades recall for precision deliberately: some genuinely unguarded call
 * in a file that mentions the platform elsewhere will now be missed. A missed
 * bug costs the reader nothing. A false one costs them their trust in the tool,
 * and they only extend that once.
 */
function isPlatformGuarded(ctx) {
  const scope = (ctx && (ctx.guardScope || ctx.nearby)) || "";
  if (/process\.platform|os\.platform\(\)|isWindows|isWin\b|IS_WINDOWS/i.test(scope)) {
    return true;
  }
  // A comparison against a platform name, whatever the variable is called.
  // agent-browser stores the platform in a local `os` and branches with
  // `if (os === 'linux')` — correct code, with a separate `os === 'win32'`
  // block right below it, and the original check could not see either.
  return /[=!]==?\s*["'`](?:linux|darwin|win32|aix|freebsd|openbsd|sunos|android)["'`]/.test(scope) ||
         /["'`](?:linux|darwin|win32|aix|freebsd|openbsd|sunos|android)["'`]\s*[=!]==?/.test(scope);
}

/**
 * True when the call sets `shell` to anything other than literal false.
 *
 * `shell: process.platform === "win32"` is the correct, idiomatic fix for a
 * .cmd spawn, so it must count as "has a shell". Only matching `shell: true`
 * would report perfectly good code, and a checker that does that gets
 * uninstalled after one run.
 */
function hasShell(call) {
  return /shell\s*:\s*(?!false\b)\S/.test(call);
}

/** True when a shell is used on Windows specifically — where quoting bites. */
function shellOnWindows(call) {
  return /shell\s*:\s*true/.test(call) ||
    /shell\s*:\s*[^,}]*(?:win32|isWin|isWindows)/i.test(call);
}

/**
 * Commands that will not run from an npm script on Windows.
 *
 * Wider than POSIX_ONLY, because an npm script runs through cmd.exe rather
 * than being spawned directly, and cmd has its own much smaller vocabulary.
 * `mkdir` exists but not `mkdir -p`; `echo` exists and is fine.
 */
const SCRIPT_POSIX_ONLY = [
  "rm", "cp", "mv", "cat", "touch", "ln", "chmod", "chown", "which",
  "sed", "awk", "grep", "ps", "kill", "pkill", "export", "source",
  "true", "false", "pwd", "uname", "sleep", "head", "tail", "wc", "du", "df",
];

/** Things that are fine and must not be mistaken for the above. */
const SCRIPT_SAFE = /^(?:npm|npx|node|yarn|pnpm|bun|deno|tsc|jest|vitest|mocha|eslint|prettier|rimraf|del|cross-env|shx|copyfiles|mkdirp|concurrently|npm-run-all|run-s|run-p|husky|tsx|ts-node|webpack|rollup|vite|esbuild|next|nest|ng|vue-cli-service|electron|nodemon|serve|http-server)\b/;

const rules = [
  {
    // The single most common Windows portability bug in the ecosystem.
    // `cross-env` exists solely because of it and does ~18M downloads a week.
    // Verified on Windows 11 / npm 11:
    //   > NODE_ENV=production node -e "..."
    //   'NODE_ENV' is not recognized as an internal or external command
    id: "npm-script-inline-env",
    severity: "bug",
    title: "Setting an environment variable inline in an npm script",
    why: "npm runs scripts through cmd.exe on Windows, and cmd has no `VAR=value command` syntax. It reads the whole thing as a command name and reports \"'NODE_ENV' is not recognized as an internal or external command\". The script fails before your program starts.",
    fix: "Use `cross-env`: \"cross-env NODE_ENV=production node app.js\". It is the package the ecosystem already standardised on for exactly this.",
    scope: "script",
    test(cmd) {
      // Each segment of a chained script is its own command.
      return cmd.split(/&&|\|\||;/).some((part) =>
        /^\s*[A-Za-z_][A-Za-z0-9_]*=[^\s=]/.test(part) &&
        // `cross-env FOO=bar` and `npx cross-env FOO=bar` are the fix, not the bug.
        !/cross-env|env\s/.test(part));
    },
  },

  {
    id: "npm-script-posix-command",
    severity: "bug",
    title: "An npm script calls a command Windows does not have",
    why: "npm scripts run through cmd.exe on Windows, which has none of the Unix tools. Verified: `rm -rf build` reports \"'rm' is not recognized as an internal or external command\". Note it may work on YOUR machine if something has put Git's usr/bin on PATH. In a published package this usually bites a Windows CONTRIBUTOR rather than a user - `npm run clean` fails for them and works for you - which is why it survives so long.",
    fix: "Use a cross-platform package instead: `rimraf` or `del-cli` for rm, `shx` for a general set (`shx cp`, `shx mkdir -p`), `copyfiles` for cp, `mkdirp` for mkdir -p.",
    scope: "script",
    test(cmd) {
      return cmd.split(/&&|\|\||;|\|/).some((part) => {
        const trimmed = part.trim().replace(/^\(\s*/, "");
        if (SCRIPT_SAFE.test(trimmed)) return false;
        const first = trimmed.match(/^([a-zA-Z][\w.-]*)\b/);
        if (!first) return false;
        // `mkdir` alone is fine on Windows; `mkdir -p` is not.
        if (first[1] === "mkdir") return /\s-p\b/.test(trimmed);
        return SCRIPT_POSIX_ONLY.includes(first[1]);
      });
    },
  },

  {
    id: "npm-script-shell-var",
    severity: "bug",
    title: "An npm script uses `$VAR` shell expansion",
    why: "cmd.exe expands `%VAR%`, not `$VAR`. On Windows the text is passed through literally, so your command receives the string \"$HOME\" instead of a path.",
    fix: "Read the variable inside your program via `process.env`, or use `cross-env-shell` which gives you a POSIX shell on both platforms.",
    scope: "script",
    test(cmd) {
      // $npm_package_* and $npm_config_* are npm's own and it substitutes them
      // itself on both platforms.
      return /\$(?!npm_)[A-Za-z_{][\w{}]*/.test(cmd);
    },
  },

  {
    // Coinbase's awal CLI: spawn(electron.cmd) with no shell -> EINVAL, and
    // the wallet could never start itself on Windows.
    id: "spawn-cmd-no-shell",
    severity: "bug",
    title: "Spawning a .cmd or .bat without `shell: true`",
    why: "Windows cannot execute a batch file directly. Node throws EINVAL, and it throws SYNCHRONOUSLY — an error-handling callback never runs, so `if (error) return` does not catch it and a throw inside a timer or event handler becomes an uncaught exception. This has been the behaviour since the Node 18.20.2 / 20.12.2 security fix for CVE-2024-27980, so code that once worked now fails.",
    fix: "Pass `shell: true` in the spawn options, or resolve to the real .exe and spawn that.",
    scope: "call",
    test(call, ctx) {
      if (!/\bspawn(Sync)?\s*\(|\bexecFile(Sync)?\s*\(/.test(call)) return false;
      let batch = /\.cmd\b|\.bat\b/.test(call);
      if (!batch && ctx && ctx.cmdVars && ctx.cmdVars.size) {
        // The first argument is a bare identifier we already know holds a
        // ".cmd" value. This is the shape the call-text regex alone misses.
        const first = call.match(/\(\s*([A-Za-z_$][\w$]*)\s*[,)]/);
        if (first && ctx.cmdVars.has(first[1])) batch = true;
      }
      if (!batch) return false;
      // Handing the batch file to cmd.exe *is* the fix, so code that already
      // does it must not be reported. projen ships
      //   cp.spawn(isWindowsBatch ? "cmd.exe" : path, …)
      // which is exactly right, and the earlier version called it a bug
      // because it saw ".cmd" in the call and no `shell:` option.
      if (/cmd\.exe|comspec/i.test(call)) return false;
      return !hasShell(call);
    },
  },

  {
    // Coinbase's payments-mcp: spawn("node_modules/.bin/electron") -> ENOENT.
    // On POSIX that path is a shell script. On Windows only .cmd/.ps1 exist.
    id: "spawn-bin-shim",
    severity: "bug",
    title: "Spawning an extensionless `node_modules/.bin/*` shim",
    why: "On POSIX that file is a shell script. On Windows npm writes `name.cmd` and `name.ps1` instead, and the extensionless file either is absent or is not executable. Node throws ENOENT.",
    fix: "Resolve the real binary (for example `require.resolve` then the package's own path), or append `.cmd` on win32 and pass `shell: true`.",
    scope: "call",
    test(call) {
      if (!/\bspawn(Sync)?\s*\(|\bexecFile(Sync)?\s*\(/.test(call)) return false;
      if (!/["'`][^"'`]*\.bin[\/\\]|["'`]\.bin["'`]|['"`]\.bin['"`]\s*,/.test(call)) return false;
      if (/\.cmd\b|\.exe\b/.test(call)) return false;
      return !hasShell(call);
    },
  },

  {
    // Coinbase's wallet bridge: execSync(`ps -p ${pid} -o command=`) with no
    // win32 branch. On Windows it threw, the catch rejected every request, and
    // the CLI hung for its full 180s timeout. Silent, and very hard to find.
    id: "posix-only-command",
    severity: "bug",
    title: "Shelling out to a command that does not exist on Windows",
    why: "The process exits non-zero or the call throws ENOENT. When that happens inside a try/catch the failure is swallowed and the symptom shows up somewhere else entirely. Note it may still work on YOUR machine: Git for Windows ships ps, which, grep, sed, rm and ls in its usr/bin, and Git Bash puts that directory on PATH while the system PATH does not. So the same code succeeds from Git Bash and throws ENOENT from PowerShell, cmd, a service or a CI runner.",
    fix: "Branch on `process.platform`, or use a cross-platform library, or do the same job in Node itself.",
    scope: "call",
    test(call, ctx) {
      if (!/\bexec(Sync|File|FileSync)?\s*\(|\bspawn(Sync)?\s*\(/.test(call)) return false;
      const cmd = call.match(/["'`]\s*([a-zA-Z][\w.-]*)\b/);
      if (!cmd || !POSIX_ONLY.includes(cmd[1])) return false;
      return !isPlatformGuarded(ctx);
    },
  },

  {
    // Coinbase's wallet hardcodes "/tmp/payments-mcp-ui-bridge". On Windows
    // that silently becomes C:\tmp, which may not exist and is not the temp dir.
    id: "hardcoded-posix-path",
    severity: "bug",
    title: "Hardcoded POSIX directory",
    why: "On Windows a leading slash resolves against the current drive, so \"/tmp/x\" quietly becomes C:\\tmp\\x. It may not exist, it is not the real temp directory, and two processes on different drives disagree about where it is.",
    fix: "Use `os.tmpdir()`, `os.homedir()`, or `env-paths`. Never hardcode a POSIX root.",
    scope: "line",
    test(line, ctx) {
      if (/^\s*(\/\/|\*|#)/.test(line)) return false;   // comment
      if (/https?:\/\//.test(line)) return false;        // URL, not a path
      // The quote must be a real string boundary, not an escaped quote inside
      // one. Prose that mentions a path — `"...so \"/tmp/x\" becomes..."` — is
      // documentation, not a hardcoded path, and flagging it is noise. This
      // rule's own `why` text tripped it in CI.
      const m = line.match(/(?:^|[^\\])["'`](\/[a-z]+)[\/"'`]/);
      if (!m || !POSIX_DIRS.includes(m[1])) return false;

      // A POSIX path inside a sentence is a message, not a path. pm2 has
      //   printError('/etc/logrotate.d does not exist we can not copy...')
      // which is a string about a path, and reporting it is pure noise.
      const literal = line.match(/(["'`])(\/[a-z][^"'`]*)\1/);
      if (literal && /\s/.test(literal[2])) return false;

      // Same idea, from the other direction: the line is reporting something,
      // not touching the disk.
      if (/console\.|\bthrow\b|printError|\blog(ger)?\s*\(|\bwarn\s*\(|\bError\s*\(/.test(line)) {
        return false;
      }

      // The path is not on this machine. firebase-tools has
      // `.copyForFirebase("/home/firebase/app", …)` — a path inside a Docker
      // image — and sandbox-cli-detector sets HOME=/home/vercel-sandbox for a
      // remote sandbox. Both are correct, and neither is a local path.
      const around = (ctx && (ctx.nearby || "")) + " " + line;
      if (/docker|container|\bimage\b|sandbox|remote|\bssh\b|dockerfile|podman/i.test(around)) {
        return false;
      }

      // Finally, and this is the big one: require some sign the string is
      // actually used as a filesystem path. Next.js passes
      // '/tmp/NEXTJS_CSS_DETECTION_FILE.scss' to webpack as a synthetic module
      // identifier that never touches a disk on any platform. Without this
      // check, a string is guilty purely for starting with a slash.
      const usedAsPath =
        /\b(path|fs|fsp|fse)\s*\.\s*\w+\s*\(/.test(line) ||
        /\b(existsSync|readFile|writeFile|readdir|mkdir|rmSync|rmdir|unlink|stat|lstat|access|realpath|createReadStream|createWriteStream|copyFile|chmod|open)\w*\s*\(/.test(line) ||
        /\b\w*(dir|path|file|folder|root|home|socket|tmp|temp|dest|target|cwd|location)\w*\s*[=:]/i.test(line);
      if (!usedAsPath) return false;

      // Comparing against a POSIX path is not using one. esbuild ships
      //   const isValidBinaryPath = (x) => !!x && x !== "/usr/bin/esbuild";
      // which is correct on every platform: on Windows nothing equals it.
      if (/[=!]==?\s*["'`]\//.test(line) || /["'`]\/[a-z][^"'`]*["'`]\s*[=!]==?/.test(line)) {
        return false;
      }

      // A constant whose own name says POSIX is deliberate, and there is
      // almost always a Windows one beside it. nx ships
      //   exports.NX_TMP_DIR_POSIX = '/tmp/.nx';
      // which is correct: the caller picks between it and the Windows path.
      if (/\b\w*(POSIX|LINUX|UNIX|DARWIN|MACOS)\w*\s*[=:]/i.test(line)) return false;

      // A POSIX default on the POSIX side of a platform branch is correct.
      // npm-check-updates has six of these — `process.platform === "win32"`
      // is on the same line as the "/usr/local" it is choosing between.
      return !isPlatformGuarded({ guardScope: line }) && !isPlatformGuarded(ctx);
    },
  },

  {
    // Coinbase's installer: spawn(process.execPath, ..., {shell:true}). Node
    // lives in "C:\Program Files\nodejs", cmd splits at the space, and the
    // pre-flight check reported "Node.js is not available" on a machine with
    // Node installed. This one cost an afternoon.
    id: "shell-true-unquoted-path",
    severity: "bug",
    title: "`shell: true` with a path that may contain spaces",
    why: "With `shell: true` the command string is handed to cmd.exe, which splits on spaces. \"C:\\Program Files\\nodejs\\node.exe\" is parsed as the command \"C:\\Program\". The failure looks like the program is missing rather than mis-quoted.",
    fix: "Drop `shell: true` and spawn the executable directly, or wrap the path in double quotes yourself before passing it.",
    scope: "call",
    test(call) {
      if (!shellOnWindows(call)) return false;
      return /process\.execPath|__dirname|__filename|process\.env\.(ProgramFiles|APPDATA|LOCALAPPDATA|USERPROFILE)/.test(call);
    },
  },

  {
    id: "posix-path-concat",
    severity: "smell",
    title: "Building a filesystem path by concatenating a slash",
    why: "Node accepts forward slashes on Windows, so this usually works. It is flagged because mixed separators break string comparisons, cache keys and anything that normalises paths later - and because the habit is what produces the real bugs above.",
    fix: "Use `path.join()` or `path.resolve()`.",
    scope: "line",
    test(line) {
      if (/^\s*(\/\/|\*|#)/.test(line)) return false;
      if (/https?:\/\/|require\(|from\s+["']|import\s|\.get\(|\.post\(|url|URL|endpoint|route/i.test(line)) return false;
      return /(__dirname|__filename|\w*[Dd]ir\w*|\w*[Pp]ath\w*)\s*\+\s*["'`]\//.test(line);
    },
  },

  {
    id: "case-sensitive-rm",
    severity: "bug",
    title: "`rm -rf` used to delete a directory",
    why: "`rm` does not exist on Windows outside Git Bash or WSL, so the delete silently fails and stale files are left behind.",
    fix: "Use `fs.rmSync(dir, { recursive: true, force: true })`.",
    scope: "call",
    test(call, ctx) {
      if (!/\bexec(Sync)?\s*\(/.test(call)) return false;
      // The `rm` has to be in the command being run, not merely somewhere in
      // the call text. Extraction grabs up to 2000 characters, so a long
      // callback can drag in unrelated code. sails-generate was reported
      // because a `console.log('    rm -rf node_modules && npm install')`
      // — advice printed for the user to read — fell inside that window.
      const firstArg = call.match(/\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/);
      if (!firstArg || !/\brm\s+-[rf]/.test(firstArg[2])) return false;
      return !isPlatformGuarded(ctx);
    },
  },
];

module.exports = { rules, POSIX_ONLY, POSIX_DIRS };
