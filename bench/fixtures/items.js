// Works on My Mac: the benchmark items.
//
// Every item is a small piece of Node or npm code written by someone on a Mac,
// with a plain statement of what they intended it to do. The LABEL is not
// written here. measure.js runs each item for real and records what happened:
//
//   works           exit 0 and the intended effect happened
//   fails_loudly    non-zero exit, a crash, or a timeout
//   fails_silently  exit 0, but the intended effect did NOT happen
//
// An item is only scored if it `works` on macOS (it has to be code that works
// on the author's Mac) and gives the SAME outcome on two different Windows
// machines. Anything else is excluded, and the reason is reported.
//
// `check` receives { out, err, status, has, read, list } after the run:
//   out/err   captured stdout/stderr, trimmed
//   status    exit code (null on timeout)
//   has(p)    does path p exist in the item's working directory
//   read(p)   file content, trimmed
//   list()    directory listing of the working directory
//
// String.raw everywhere so a backslash in embedded code survives exactly.

const npm = (id, intent, script, check, files) =>
  ({ id, kind: "npm", intent, script, check, files: files || {} });
const node = (id, intent, code, check, files) =>
  ({ id, kind: "node", intent, code, check, files: files || {} });
const esm = (id, intent, code, check, files) =>
  ({ id, kind: "esm", intent, code, check, files: files || {} });

const ECHO_ARG = { "echo-arg.js": "console.log(process.argv[2]);" };

module.exports = [
  // ----------------------------------------------------------------- npm scripts
  npm("npm-inline-env",
    "Run node with NODE_ENV set to production; it should print production.",
    String.raw`NODE_ENV=production node -e "console.log(process.env.NODE_ENV)"`,
    (r) => r.out === "production"),

  npm("npm-inline-env-two",
    "Set two environment variables inline; node should print 12.",
    String.raw`A=1 B=2 node -e "console.log(process.env.A + process.env.B)"`,
    (r) => r.out === "12"),

  npm("npm-export",
    "Export PORT and start node, which should print 3000.",
    String.raw`export PORT=3000 && node -e "console.log(process.env.PORT)"`,
    (r) => r.out === "3000"),

  npm("npm-rm-rf",
    "Delete the build directory, then print cleaned.",
    String.raw`rm -rf build && echo cleaned`,
    (r) => !r.has("build") && r.out.includes("cleaned"),
    { "build/old.txt": "stale" }),

  npm("npm-cp",
    "Copy a.txt to b.txt.",
    String.raw`cp a.txt b.txt`,
    (r) => r.has("b.txt") && r.read("b.txt") === "hello",
    { "a.txt": "hello" }),

  npm("npm-mv",
    "Rename a.txt to b.txt.",
    String.raw`mv a.txt b.txt`,
    (r) => r.has("b.txt") && !r.has("a.txt"),
    { "a.txt": "hello" }),

  npm("npm-mkdir-p",
    "Create the nested directory out/nested/deep.",
    String.raw`mkdir -p out/nested/deep`,
    (r) => r.has("out/nested/deep")),

  npm("npm-mkdir-plain",
    "Create a directory called out.",
    String.raw`mkdir out`,
    (r) => r.has("out")),

  npm("npm-cat",
    "Print the contents of a.txt.",
    String.raw`cat a.txt`,
    (r) => r.out === "hello",
    { "a.txt": "hello" }),

  npm("npm-pipe-grep",
    "Pipe node's output through grep; ok should be printed.",
    String.raw`node -e "console.log('ok')" | grep ok`,
    (r) => r.out === "ok"),

  npm("npm-sleep",
    "Wait one second, then print done.",
    String.raw`sleep 1 && echo done`,
    (r) => r.out === "done"),

  npm("npm-node-relative-slash",
    "Run scripts/build.js with node; it should print built.",
    String.raw`node ./scripts/build.js`,
    (r) => r.out === "built",
    { "scripts/build.js": "console.log('built');" }),

  npm("npm-dot-bin-path",
    "Remove the build directory using the locally installed rimraf binary.",
    String.raw`./node_modules/.bin/rimraf build`,
    (r) => !r.has("build"),
    { "build/old.txt": "stale" }),

  npm("npm-echo-single-quotes",
    "Print the words hello world.",
    String.raw`echo 'hello world'`,
    (r) => r.out === "hello world"),

  npm("npm-echo-double-quotes",
    "Print the words hello world.",
    String.raw`echo "hello world"`,
    (r) => r.out === "hello world"),

  npm("npm-echo-plain",
    "Print the words hello world.",
    String.raw`echo hello world`,
    (r) => r.out === "hello world"),

  npm("npm-dollar-var-arg",
    "Pass the package name (npm sets npm_package_name) to node, which prints it: bench-fixture.",
    String.raw`node -e "console.log(process.argv[1])" $npm_package_name`,
    (r) => r.out === "bench-fixture"),

  npm("npm-single-quoted-arg",
    "Pass the single argument 'two words' to echo-arg.js, which prints its first argument.",
    String.raw`node echo-arg.js 'two words'`,
    (r) => r.out === "two words",
    ECHO_ARG),

  npm("npm-double-quoted-arg",
    "Pass the single argument \"two words\" to echo-arg.js, which prints its first argument.",
    String.raw`node echo-arg.js "two words"`,
    (r) => r.out === "two words",
    ECHO_ARG),

  npm("npm-semicolon",
    "Run two node commands one after the other, printing 1 and then 2.",
    String.raw`node -e "console.log(1)"; node -e "console.log(2)"`,
    (r) => r.out.replace(/\s+/g, " ") === "1 2"),

  npm("npm-or-fallback",
    "Run a command that fails, and print recovered when it does.",
    String.raw`node -e "process.exit(1)" || echo recovered`,
    (r) => r.out === "recovered"),

  npm("npm-and-chain",
    "Run two node commands in sequence, printing 1 and then 2.",
    String.raw`node -e "console.log(1)" && node -e "console.log(2)"`,
    (r) => r.out.replace(/\s+/g, " ") === "1 2"),

  npm("npm-redirect-file",
    "Write the letter x into out.txt.",
    String.raw`node -e "console.log('x')" > out.txt`,
    (r) => r.has("out.txt") && r.read("out.txt") === "x"),

  npm("npm-stderr-devnull",
    "Hide node's stderr noise and print ok.",
    String.raw`node -e "console.error('noise'); console.log('ok')" 2>/dev/null`,
    (r) => r.out === "ok"),

  npm("npm-stdout-devnull",
    "Discard node's output, then print done.",
    String.raw`node -e "console.log('x')" > /dev/null && echo done`,
    (r) => r.out === "done"),

  npm("npm-cross-env",
    "Use cross-env to run node with NODE_ENV=production; it should print production.",
    String.raw`cross-env NODE_ENV=production node -e "console.log(process.env.NODE_ENV)"`,
    (r) => r.out === "production"),

  npm("npm-rimraf",
    "Delete the build directory with rimraf, then print cleaned.",
    String.raw`rimraf build && echo cleaned`,
    (r) => !r.has("build") && r.out.includes("cleaned"),
    { "build/old.txt": "stale" }),

  npm("npm-shx-cp",
    "Copy a.txt to b.txt using shx.",
    String.raw`shx cp a.txt b.txt`,
    (r) => r.has("b.txt") && r.read("b.txt") === "hello",
    { "a.txt": "hello" }),

  npm("npm-test-f",
    "Print exists if package.json is present.",
    String.raw`test -f package.json && echo exists`,
    (r) => r.out === "exists"),

  npm("npm-command-substitution",
    "Pass the output of an inner node command (abc) to an outer node command that prints it.",
    String.raw`node -e "console.log(process.argv[1])" $(node -e "process.stdout.write('abc')")`,
    (r) => r.out === "abc"),

  npm("npm-or-true",
    "Run a command that may fail, but never let the script as a whole fail.",
    String.raw`node -e "process.exit(1)" || true`,
    (r) => r.status === 0),

  npm("npm-cd-subdir",
    "Change into sub/ and check that x.txt is there; it should print true.",
    String.raw`cd sub && node -e "console.log(require('fs').existsSync('x.txt'))"`,
    (r) => r.out === "true",
    { "sub/x.txt": "x" }),

  npm("npm-package-version-env",
    "Print the package version, which npm exposes as npm_package_version: 1.0.0.",
    String.raw`node -e "console.log(process.env.npm_package_version)"`,
    (r) => r.out === "1.0.0"),

  npm("npm-glob-arg",
    "Pass every .txt file to node, which prints how many it received: 2.",
    String.raw`node -e "console.log(process.argv.length - 1)" *.txt`,
    (r) => r.out === "2",
    { "a.txt": "a", "b.txt": "b" }),

  npm("npm-tilde-arg",
    "Pass the path ~/notes to node, which prints it; it should be expanded to the home directory.",
    String.raw`node -e "console.log(process.argv[1])" ~/notes`,
    (r) => !r.out.startsWith("~") && r.out.endsWith("notes")),

  npm("npm-which",
    "Print the path of the node executable.",
    String.raw`which node`,
    (r) => /node/i.test(r.out)),

  npm("npm-ls",
    "List the files in the current directory; a.txt should appear.",
    String.raw`ls`,
    (r) => r.out.includes("a.txt"),
    { "a.txt": "a" }),

  // --------------------------------------------------------------- node (CJS)
  node("js-spawn-npm",
    "Run npm --version as a child process and print the version.",
    String.raw`const { spawn } = require("child_process");
const child = spawn("npm", ["--version"]);
child.stdout.on("data", (d) => process.stdout.write(d));
child.on("close", (code) => process.exit(code));`,
    (r) => /^\d+\.\d+\.\d+$/.test(r.out)),

  node("js-spawnsync-npm-cmd",
    "Run npm --version, using npm.cmd on Windows as is conventional, and print the version.",
    String.raw`const { spawnSync } = require("child_process");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const r = spawnSync(npm, ["--version"], { encoding: "utf8" });
console.log(r.stdout.trim());`,
    (r) => /^\d+\.\d+\.\d+$/.test(r.out)),

  node("js-spawnsync-npm-cmd-shell",
    "Run npm --version, using npm.cmd on Windows and a shell, and print the version.",
    String.raw`const { spawnSync } = require("child_process");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const r = spawnSync(npm, ["--version"], { encoding: "utf8", shell: true });
console.log(r.stdout.trim());`,
    (r) => /^\d+\.\d+\.\d+$/.test(r.out)),

  node("js-execsync-rm",
    "Delete the build directory with a shell command, then print cleaned.",
    String.raw`const { execSync } = require("child_process");
execSync("rm -rf build");
console.log("cleaned");`,
    (r) => !r.has("build") && r.out === "cleaned",
    { "build/old.txt": "stale" }),

  node("js-execsync-node",
    "Print the version of node by running node --version.",
    String.raw`const { execSync } = require("child_process");
console.log(execSync("node --version").toString().trim());`,
    (r) => /^v\d+/.test(r.out)),

  node("js-ps-swallowed",
    "Print the name of the current process, or unknown if it cannot be determined; on a normal machine it should print node.",
    String.raw`const { execSync } = require("child_process");
let name;
try {
  name = execSync("ps -p " + process.pid + " -o comm=").toString().trim();
} catch (e) {
  name = "unknown";
}
console.log(name.split("/").pop());`,
    (r) => /node/i.test(r.out)),

  node("js-require-wrong-case",
    "Load the Utils module and print the number it exports: 42.",
    String.raw`console.log(require("./utils"));`,
    (r) => r.out === "42",
    { "Utils.js": "module.exports = 42;" }),

  node("js-readfile-wrong-case",
    "Read the config file and print its name field: demo.",
    String.raw`const fs = require("fs");
console.log(JSON.parse(fs.readFileSync("./config.json", "utf8")).name);`,
    (r) => r.out === "demo",
    { "Config.json": '{"name":"demo"}' }),

  node("js-colon-filename",
    "Save a file called notes:draft.txt and confirm it appears in the directory listing (print true).",
    String.raw`const fs = require("fs");
fs.writeFileSync("notes:draft.txt", "x");
console.log(fs.readdirSync(".").includes("notes:draft.txt"));`,
    (r) => r.out === "true"),

  node("js-question-mark-filename",
    "Save a report called report?.txt and print saved.",
    String.raw`const fs = require("fs");
fs.writeFileSync("report?.txt", "x");
console.log("saved");`,
    (r) => r.out === "saved"),

  node("js-trailing-dot-filename",
    "Save a file called draft. (with a trailing dot) and confirm it appears in the listing under that exact name (print true).",
    String.raw`const fs = require("fs");
fs.writeFileSync("draft.", "x");
console.log(fs.readdirSync(".").includes("draft."));`,
    (r) => r.out === "true"),

  node("js-reserved-name",
    "Save a file called con.txt and print its contents back: hi.",
    String.raw`const fs = require("fs");
fs.writeFileSync("con.txt", "hi");
console.log(fs.readFileSync("con.txt", "utf8"));`,
    (r) => r.out === "hi" && r.list().includes("con.txt")),

  node("js-split-os-eol",
    "Split a two-line string written with \\n into lines and print the line count: 2.",
    String.raw`const os = require("os");
const text = "first\nsecond";
console.log(text.split(os.EOL).length);`,
    (r) => r.out === "2"),

  node("js-split-path-slash",
    "Print just the file name of the current script: main.js.",
    String.raw`console.log(__filename.split("/").pop());`,
    (r) => r.out === "main.js"),

  node("js-path-basename",
    "Print just the file name of the current script: main.js.",
    String.raw`const path = require("path");
console.log(path.basename(__filename));`,
    (r) => r.out === "main.js"),

  node("js-getuid",
    "Print true if the current user's numeric id is available.",
    String.raw`console.log(typeof process.getuid() === "number");`,
    (r) => r.out === "true"),

  node("js-home-env",
    "Print the path of ~/.myapprc using the user's home directory.",
    String.raw`const path = require("path");
console.log(path.join(process.env.HOME, ".myapprc"));`,
    (r) => r.out.endsWith(".myapprc") && r.out.length > ".myapprc".length + 1),

  node("js-os-homedir",
    "Print the path of ~/.myapprc using the user's home directory.",
    String.raw`const os = require("os");
const path = require("path");
console.log(path.join(os.homedir(), ".myapprc"));`,
    (r) => r.out.endsWith(".myapprc") && r.out.length > ".myapprc".length + 1),

  node("js-chmod-exec-bit",
    "Create run.sh and make it executable; print true if it is now executable.",
    String.raw`const fs = require("fs");
fs.writeFileSync("run.sh", "echo hi\n");
fs.chmodSync("run.sh", 0o755);
console.log((fs.statSync("run.sh").mode & 0o111) !== 0);`,
    (r) => r.out === "true"),

  node("js-sigterm-cleanup",
    "Start a worker that writes a cleaned marker when it receives SIGTERM, stop it with SIGTERM, and print true if cleanup ran.",
    String.raw`const { spawn } = require("child_process");
const fs = require("fs");
const code = "process.on('SIGTERM', () => { require('fs').writeFileSync('cleaned', '1'); process.exit(0); });" +
  "console.log('ready'); setInterval(() => {}, 1000);";
const child = spawn(process.execPath, ["-e", code]);
child.stdout.once("data", () => child.kill("SIGTERM"));
child.on("exit", () => console.log(fs.existsSync("cleaned")));`,
    (r) => r.out === "true"),

  node("js-self-signal-usr2",
    "Listen for SIGUSR2 to trigger a reload, send it to ourselves, and print reload.",
    String.raw`process.on("SIGUSR2", () => { console.log("reload"); process.exit(0); });
process.kill(process.pid, "SIGUSR2");
setTimeout(() => {}, 2000);`,
    (r) => r.out === "reload"),

  node("js-unlink-open-file",
    "Delete a.txt while it is still open for reading, and print true once it no longer exists.",
    String.raw`const fs = require("fs");
const fd = fs.openSync("a.txt", "r");
fs.unlinkSync("a.txt");
console.log(!fs.existsSync("a.txt"));
fs.closeSync(fd);`,
    (r) => r.out === "true",
    { "a.txt": "data" }),

  node("js-etc-hosts",
    "Print true if the system hosts file at /etc/hosts exists.",
    String.raw`const fs = require("fs");
console.log(fs.existsSync("/etc/hosts"));`,
    (r) => r.out === "true"),

  node("js-execsync-echo-home",
    "Ask the shell for $HOME and print it; it should be the home directory path.",
    String.raw`const { execSync } = require("child_process");
console.log(execSync("echo $HOME").toString().trim());`,
    (r) => r.out.length > 1 && !r.out.includes("$")),

  node("js-symlink",
    "Create a symbolic link link.txt pointing at target.txt and print the linked content: hello.",
    String.raw`const fs = require("fs");
fs.symlinkSync("target.txt", "link.txt");
console.log(fs.readFileSync("link.txt", "utf8"));`,
    (r) => r.out === "hello",
    { "target.txt": "hello" }),

  node("js-path-join-forward-slash",
    "Write data.txt inside out/ using path.join with a forward-slash segment, then print it back: ok.",
    String.raw`const fs = require("fs");
const path = require("path");
fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "out/data.txt"), "ok");
console.log(fs.readFileSync(path.join(__dirname, "out/data.txt"), "utf8"));`,
    (r) => r.out === "ok"),

  // ------------------------------------------------------------------- ESM
  esm("esm-url-pathname",
    "Read this module's own source file and print true if it is non-empty.",
    String.raw`import fs from "node:fs";
const src = fs.readFileSync(new URL(import.meta.url).pathname, "utf8");
console.log(src.length > 0);`,
    (r) => r.out === "true"),

  esm("esm-fileurltopath",
    "Read this module's own source file and print true if it is non-empty.",
    String.raw`import fs from "node:fs";
import { fileURLToPath } from "node:url";
const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
console.log(src.length > 0);`,
    (r) => r.out === "true"),

  esm("esm-import-absolute-path",
    "Dynamically import mod.mjs by its absolute path and print its default export: 7.",
    String.raw`import path from "node:path";
const mod = await import(path.resolve("mod.mjs"));
console.log(mod.default);`,
    (r) => r.out === "7",
    { "mod.mjs": "export default 7;" }),

  esm("esm-import-file-url",
    "Dynamically import mod.mjs by its absolute path and print its default export: 7.",
    String.raw`import path from "node:path";
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(path.resolve("mod.mjs")).href);
console.log(mod.default);`,
    (r) => r.out === "7",
    { "mod.mjs": "export default 7;" }),
];
