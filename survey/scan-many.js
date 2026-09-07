// Scan every extracted package dir given on argv; emit one JSON line each.
const path = require("path");
// Resolved relative to this file so the harness runs from a fresh clone.
const { scan } = require(path.join(__dirname, "..", "lib", "scan.js"));

for (const dir of process.argv.slice(2)) {
  const pkgRoot = path.join(dir, "package");
  const name = path.basename(dir);
  const out = { name, error: null, files: 0, findings: [] };
  try {
    const r = scan(pkgRoot, { includeBuild: true });
    out.files = r.files;
    out.findings = r.findings.map((f) => ({
      rule: f.rule,
      severity: f.severity,
      line: f.line,
      file: path.relative(pkgRoot, f.file).split(path.sep).join("/"),
      source: f.source,
    }));
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}
