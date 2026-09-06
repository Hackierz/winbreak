// Fixture for false positives. Everything here is correct cross-platform code
// and must produce ZERO findings. A linter that cries wolf gets uninstalled.
"use strict";

const { spawn, execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

// correct: shell: true is set for the batch file
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
function installDeps(dir) {
  return spawn(npmCmd, ["install"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
}

// correct: resolves the real executable, no shim
function startElectron(dir, app) {
  const exe = process.platform === "win32"
    ? path.join(dir, "node_modules", "electron", "dist", "electron.exe")
    : path.join(dir, "node_modules", ".bin", "electron");
  return spawn(exe, [app], { stdio: "inherit", shell: false });
}

// correct: the POSIX command is behind a platform guard
function isRunning(pid) {
  if (process.platform !== "win32") {
    return execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).length > 0;
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// correct: real temp dir, joined properly
const BRIDGE_DIR = path.join(os.tmpdir(), "bridge");
const HOME_CFG = path.join(os.homedir(), ".config");

// correct: no shell, so no quoting problem
function checkNode() {
  return spawn(process.execPath, ["--version"], { stdio: "pipe" });
}

// correct: path.join, not string concatenation
function assetPath(name) {
  return path.join(__dirname, "assets", name);
}

// correct: Node's own recursive remove
function wipe(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// a URL is not a filesystem path and must not be flagged
const API_BASE = "https://api.example.com/v1";
const endpoint = API_BASE + "/users";


// Prose that MENTIONS a POSIX path is documentation, not a hardcoded path.
// This exact shape — an escaped quote immediately before the path — appears in
// winbreak's own rule descriptions and broke its CI.
const HELP = "on Windows a leading slash means \"/tmp/x\" becomes C:\\tmp\\x";

module.exports = { installDeps, startElectron, isRunning, checkNode, assetPath, wipe, BRIDGE_DIR, HOME_CFG, endpoint, HELP };
