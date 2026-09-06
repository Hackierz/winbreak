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

/** Directories that exist on POSIX and not on Windows. */
const POSIX_DIRS = ["/tmp", "/usr", "/etc", "/var", "/home", "/opt", "/dev", "/proc", "/root"]; // winbreak-ignore

/** True when the surrounding lines already branch on the platform. */
function isPlatformGuarded(ctx) {
  return /process\.platform|os\.platform\(\)|isWindows|isWin\b|IS_WINDOWS/i.test(ctx.nearby);
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
    title: "Hardcoded POSIX directory",
    why: "On Windows a leading slash resolves against the current drive, so \"/tmp/x\" quietly becomes C:\\tmp\\x. It may not exist, it is not the real temp directory, and two processes on different drives disagree about where it is.",
    fix: "Use `os.tmpdir()`, `os.homedir()`, or `env-paths`. Never hardcode a POSIX root.",
    scope: "line",
    test(line) {
      if (/^\s*(\/\/|\*|#)/.test(line)) return false;   // comment
      if (/https?:\/\//.test(line)) return false;        // URL, not a path
      // The quote must be a real string boundary, not an escaped quote inside
      // one. Prose that mentions a path — `"...so \"/tmp/x\" becomes..."` — is
      // documentation, not a hardcoded path, and flagging it is noise. This
      // rule's own `why` text tripped it in CI.
      const m = line.match(/(?:^|[^\\])["'`](\/[a-z]+)[\/"'`]/);
      return !!m && POSIX_DIRS.includes(m[1]);
    },
  },

  {
    // Coinbase's installer: spawn(process.execPath, ..., {shell:true}). Node
    // lives in "C:\Program Files\nodejs", cmd splits at the space, and the
    // pre-flight check reported "Node.js is not available" on a machine with
    // Node installed. This one cost an afternoon.
    id: "shell-true-unquoted-path",
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
    title: "Building a filesystem path by concatenating a slash",
    why: "Windows tolerates forward slashes in many places but not all, and mixed separators break string comparisons, cache keys and anything that normalises paths later.",
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
