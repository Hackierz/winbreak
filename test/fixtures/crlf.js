// CRLF line endings — the Windows default.
// Line offsets must come from real newline positions, not from
// length + 1, or every finding drifts further down the file.
// pad 4
// pad 5
// pad 6
// pad 7
// pad 8
// pad 9
// pad 10
// pad 11
// pad 12
const { spawn } = require("child_process");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
spawn(npmCmd, ["install"], { stdio: "inherit" });
