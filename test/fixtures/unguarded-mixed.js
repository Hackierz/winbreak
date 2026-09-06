// A REAL bug in a file that mentions win32 elsewhere.
//
// This is Coinbase awal's dist/utils/serverManager.js shape. A flat look-back
// window sees the `win32` on the lines below and wrongly calls the `rm -rf`
// guarded. It is not guarded. winbreak must still report it.

const { execSync, spawn } = require("child_process");

function installBundle(bundleDir) {
  // Use rm -rf for cross-platform removal   <- the comment is wrong
  execSync('rm -rf "' + bundleDir + '"', { stdio: "pipe" });
}

function startServer(dir) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawn(npmCmd, ["start"], {
    cwd: dir,
    shell: process.platform === "win32",
  });
}

module.exports = { installBundle, startServer };
