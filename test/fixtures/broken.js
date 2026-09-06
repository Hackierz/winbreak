// Fixture. Every block below is a real bug shape taken from shipped software.
// This file is never executed — it exists so the rules have something to catch.
"use strict";

const { spawn, execSync, exec } = require("child_process");
const path = require("path");

// 1. spawn-cmd-no-shell, via a tracked variable.
//    Coinbase awal: this is why the wallet could not start itself on Windows.
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
function installDeps(dir) {
  return spawn(npmCmd, ["install", "--omit=dev"], { cwd: dir, stdio: "inherit" });
}

// 1b. same rule, literal in the call
function runYarn() {
  return spawn("yarn.cmd", ["build"], { stdio: "inherit" });
}

// 2. spawn-bin-shim
//    Coinbase payments-mcp: ENOENT, because .bin/electron is a shell script.
function startElectron(dir, app) {
  return spawn(path.join(dir, "node_modules", ".bin", "electron"), [app], {
    stdio: ["inherit", "inherit", "inherit"],
  });
}

// 3. posix-only-command
//    Coinbase wallet bridge: threw on Windows, the catch swallowed it, and
//    every CLI request was silently rejected for 180 seconds.
function isOurProcess(pid) {
  const out = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" });
  return out.includes("payments-mcp");
}

// 4. hardcoded-posix-path
const BRIDGE_DIR = "/tmp/payments-mcp-ui-bridge";
const LOCK_FILE = "/tmp/payments-mcp-ui.lock";

// 5. shell-true-unquoted-path
//    Node lives in "C:\Program Files\nodejs". cmd splits at the space and
//    reports that Node is missing on a machine that has Node.
function checkNode() {
  return spawn(process.execPath, ["--version"], { shell: true, stdio: "pipe" });
}

// 6. posix-path-concat
function assetPath(name) {
  return __dirname + "/assets/" + name;
}

// 7. case-sensitive-rm
function wipe(dir) {
  execSync(`rm -rf "${dir}"`, { stdio: "pipe" });
}

module.exports = { installDeps, runYarn, startElectron, isOurProcess, checkNode, assetPath, wipe, BRIDGE_DIR, LOCK_FILE };
