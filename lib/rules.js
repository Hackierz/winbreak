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
  "whoami", "id", "kill", "pkill", "killall", "sed", "awk", "grep",
  "readlink", "dirname", "basename", "mktemp", "touch", "sudo",
];

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
  return /process\.platform|os\.platform\(\)|isWindows|isWin\b|IS_WINDOWS/i.test(scope);
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

const rules = [
  {
    // Coinbase's awal CLI: spawn(electron.cmd) with no shell -> EINVAL, and
    // the wallet could never start itself on Windows.
    id: "spawn-cmd-no-shell",
    severity: "bug",
    title: "Spawning a .cmd or .bat without `shell: true`",
    why: "Windows cannot execute a batch file directly. Node throws EINVAL. This has been the behaviour since the Node 18.20 / 20.12 security fix, so code that once worked now fails.",
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
    why: "The process exits non-zero or the call throws. When that happens inside a try/catch the failure is swallowed and the symptom shows up somewhere else entirely.",
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
      if (!/rm\s+-[rf]/.test(call)) return false;
      return !isPlatformGuarded(ctx);
    },
  },
];

module.exports = { rules, POSIX_ONLY, POSIX_DIRS };
