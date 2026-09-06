// Correct code that winbreak wrongly reported. Zero bugs expected.
//
// Every case here came from scanning the 600 most-downloaded npm CLI packages
// and then reading each finding by hand. The count was the easy part; being
// right about it was not.

const { exec, execSync, spawn } = require("child_process");
const cp = require("child_process");

// --- agent-browser ------------------------------------------------------
// The platform is held in a local variable and compared to a platform NAME.
// Guard detection only looked for `process.platform` / `isWindows`, so it
// could not see this, and reported a correctly guarded `which` as a bug.
// Worse: enclosingBlock stripped string literals before collecting the block
// header, so the guard arrived as `if (os === '') {` with the name gone.
function findSystemChrome(os) {
  if (os === "linux") {
    for (const name of ["google-chrome", "chromium"]) {
      try {
        const result = execSync(`which ${name} 2>/dev/null`, { encoding: "utf8" }).trim();
        if (result) return result;
      } catch {}
    }
    return null;
  }
  if (os === "win32") {
    return `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`;
  }
  return null;
}

// --- projen -------------------------------------------------------------
// Handing a .cmd to cmd.exe IS the documented fix. Reporting it as the bug it
// fixes is the worst kind of false positive.
function spawnCommand(file, options) {
  const isWindowsBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  return cp.spawn(
    isWindowsBatch ? "cmd.exe" : file,
    isWindowsBatch ? ["/c", file].concat(options.args) : options.args,
    { cwd: options.cwd }
  );
}

// --- sails-generate -----------------------------------------------------
// `rm -rf` printed as advice for a human to read, not executed. Call
// extraction reads up to 2000 characters, so this text fell inside the window
// of the exec() call further down and was reported against it.
function printHelp() {
  console.log("    rm -rf node_modules && npm install");
  console.log("For more help, visit the docs.");
}

function install(dir, cb) {
  exec("npm install", { cwd: dir }, function (err) {
    if (err) return cb(err);
    return cb(null);
  });
}

// --- pm2 and bugsnag-build-reporter -------------------------------------
// `whoami` ships with Windows and has since Vista. It was in the POSIX-only
// list and should never have been.
function currentUser(cb) {
  return exec("whoami", cb);
}

// --- a genuinely guarded POSIX-only call, if/else form ------------------
function killTree(pid) {
  if (process.platform === "win32") {
    return exec(`taskkill /pid ${pid} /T /F`);
  } else {
    return spawn("ps", ["-e", "-o", "pid=,ppid="]);
  }
}

// --- the same guard as an early return ----------------------------------
// A very common shape, and the brace walk cannot see it: the `if` does not
// enclose the call, it just leaves before reaching it.
function listProcesses() {
  if (process.platform === "win32") return null;
  return execSync("ps -e -o pid=,ppid=", { encoding: "utf8" });
}

module.exports = {
  findSystemChrome, spawnCommand, printHelp, install,
  currentUser, killTree, listProcesses,
};
