// Correct cross-platform code. winbreak must report ZERO bugs here.
//
// This fixture is shaped like nodemon's lib/monitor/run.js, which winbreak
// once reported two bugs in. Both were false positives: the POSIX-only calls
// live in the `else` half of a platform branch that opens ~90 lines above
// them. A narrow look-back window could not see the guard, and a wide flat
// one suppressed real bugs elsewhere. Guard detection walks braces now.

const { exec, execSync } = require("child_process");

const utils = { isWindows: process.platform === "win32" };

function killProcess(pid, signal) {
  if (utils.isWindows) {
    // Windows branch: plenty of padding, so the guard is far from the calls
    // in the else branch below. That distance is the whole point.
    const a = 1;
    const b = 2;
    const c = 3;
    const d = 4;
    const e = 5;
    const f = 6;
    const g = 7;
    const h = 8;
    const i = 9;
    const j = 10;
    const k = 11;
    const l = 12;
    const m = 13;
    const n = 14;
    const o = 15;
    const p = 16;
    const q = 17;
    const r = 18;
    const s = 19;
    const t = 20;
    const u = 21;
    const v = 22;
    const w = 23;
    const x = 24;
    const y = 25;
    const z = 26;
    exec("taskkill /pid " + pid + " /T /F");
    return a + b + c + d + e + f + g + h + i + j + k + l + m
      + n + o + p + q + r + s + t + u + v + w + x + y + z;
  } else {
    // POSIX-only, and correct, because Windows never reaches this line.
    exec("kill -" + signal + " " + pid);
    execSync("ps -p " + pid + " -o command=");
    return 0;
  }
}

function removeDir(dir) {
  if (process.platform !== "win32") {
    execSync("rm -rf " + dir);
  }
}

module.exports = { killProcess, removeDir };
