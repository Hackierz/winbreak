// One hop: the executable path lives in a variable and the call only names it.
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const exe = path.join(process.env.ProgramFiles, "nodejs", "node.exe");
spawnSync(exe, ["--version"], { shell: true });          // bug: one hop

spawnSync(exe, ["--version"]);                           // fine: no shell

const name = "npm";
spawn(name, ["--version"], { shell: true });              // fine: not a path

const here = __dirname;
spawn(here, [], { shell: true });                         // bug: one hop
