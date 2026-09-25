// Fixture for shell-true-args-array (DEP0190). Never executed.
//
// Which calls warn was measured on Windows 11 / Node 24.20.0, one API per
// fresh process: spawn, spawnSync, execFile and execFileSync print DEP0190
// when given an args array and a shell; exec, execSync, fork, an empty args
// array and shell: false do not.
"use strict";

const child_process = require("child_process");
const { spawn, spawnSync, execFile, execFileSync, exec, execSync } = child_process;

const args = ["run", "build"];
const cmd = "npm";
const opts = { stdio: "inherit", shell: true };
const cli = process.env.npm_execpath;
const done = () => {};

// --- fires ---------------------------------------------------------------
spawnSync("npm", ["--version"], { shell: true });                          // 19
spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" }); // 20
execFile("git", ["log", "-1"], { shell: true }, done);                     // 21
execFileSync("tsc", args, { shell: "cmd.exe" });                           // 22
// the old advice for a .cmd: no longer EINVAL, but the args are concatenated
child_process.spawn("npm.cmd", ["install"], { shell: true });              // 24
spawn(                                                                     // 25
  "npm",
  ["run", "build"],
  { stdio: "inherit", shell: true }
);

// --- must not fire -------------------------------------------------------
spawnSync("npm --version", { shell: true });          // one command string
exec("npm --version", { shell: "cmd.exe" }, done);    // exec takes one string
execSync("npm run build");                            // so does execSync
spawnSync(process.execPath, [cli, "--version"]);      // no shell: the fix
spawnSync("node", ["x.js"], { shell: false });        // shell off
spawn("node", [], { shell: true });                   // empty array: no warning
spawnSync("node", undefined, { shell: true });        // no args at all
spawn(cmd, args, opts);                               // options we cannot see
spawn(cmd);                                           // one argument
execFile("node", ["a.js"], (err) => {                 // the shell belongs to
  if (!err) spawn("x", { shell: true });              // a different call
});
spawn(`"${cli}" --version`, { shell: true });         // quoted string

// Values Node treats as "no shell". Measured on Node 24.20.0: the child gets
// ["two words"] and no DEP0190 is printed for undefined, null or "".
spawnSync("npm", ["i"], { shell: undefined });
spawnSync("node", ["x"], { shell: null });
spawnSync("node", ["x"], { shell: "" });
// Keys that merely end in "shell", and a nested one.
spawnSync("npm", ["i"], { noshell: true });
spawnSync("npm", ["i"], { env: { ...process.env, npm_config_script_shell: "bash" } });
spawn(cmd, args, {
  // shell: true splits arguments, so it is off here
  stdio: "inherit",
});
spawn(cmd, args, { stdio: "inherit" /* , shell: true */ });

// --- fires (review round) -----------------------------------------------
const shell = process.platform === "win32";
spawn("npm", ["i"], { shell });                                            // 62
spawn("npm", ["run", "build"], { shell: true, cwd: __dirname });           // 63
spawnSync("npm", ["i"], { ...opts, "shell": true });                       // 64

module.exports = {};
