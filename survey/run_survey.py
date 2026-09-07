import json, os, shutil, subprocess, sys, tarfile, urllib.request, io, time
from concurrent.futures import ThreadPoolExecutor

TOP = int(sys.argv[1]) if len(sys.argv) > 1 else 400
CHUNK = 20
WORK = os.path.abspath("work-%d" % os.getpid())
RESULTS = os.path.abspath(os.environ.get("RESULTS", "results.jsonl"))

names = []
with open("ranked.tsv") as f:
    for line in f:
        n, d = line.rstrip("\n").split("\t")
        names.append((n, int(d)))
names = names[:TOP]

done = set()
if os.path.exists(RESULTS):
    with open(RESULTS) as f:
        for line in f:
            try: done.add(json.loads(line)["name"])
            except: pass
names = [(n, d) for n, d in names if n not in done]
print(f"to do: {len(names)}", flush=True)

def fetch(item):
    name, dl = item
    dest = os.path.join(WORK, name)
    try:
        with urllib.request.urlopen(f"https://registry.npmjs.org/{name}/latest", timeout=30) as r:
            meta = json.load(r)
        url = meta["dist"]["tarball"]
        ver = meta.get("version", "?")
        with urllib.request.urlopen(url, timeout=90) as r:
            blob = r.read()
        os.makedirs(dest, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as t:
            for m in t.getmembers():
                # stay inside dest; skip anything with an absolute or ../ path
                p = os.path.normpath(os.path.join(dest, m.name))
                if not p.startswith(os.path.normpath(dest)): continue
                if m.isreg() and m.size < 4_000_000:
                    t.extract(m, dest)
        return (name, ver, dl, len(blob), None)
    except Exception as e:
        return (name, "?", dl, 0, str(e)[:120])

os.makedirs(WORK, exist_ok=True)
out = open(RESULTS, "a")
for i in range(0, len(names), CHUNK):
    batch = names[i:i+CHUNK]
    with ThreadPoolExecutor(max_workers=8) as ex:
        fetched = list(ex.map(fetch, batch))
    ok = [f for f in fetched if f[4] is None]
    meta = {f[0]: {"version": f[1], "downloads": f[2], "bytes": f[3]} for f in ok}
    for f in fetched:
        if f[4] is not None:
            out.write(json.dumps({"name": f[0], "error": f[4], "downloads": f[2]}) + "\n")
    dirs = [os.path.join(WORK, f[0]) for f in ok]
    if dirs:
        try:
            # Explicit utf-8: text=True decodes with the locale codec, which on
            # Windows is cp1252, and one package in 600 contains a byte cp1252
            # has no mapping for. That raised UnicodeDecodeError *before* the
            # returncode check below could ever run, and the handler below
            # printed a line and carried on -- twenty packages silently absent
            # from the results.
            p = subprocess.run(["node", "scan-many.js"] + dirs,
                               capture_output=True, encoding="utf-8",
                               errors="replace", timeout=600)
            # Never let the scanner fail in silence. The first run of this
            # produced an empty results file and looked like a clean survey.
            if p.returncode != 0:
                print("SCANNER FAILED rc=%s: %s" % (p.returncode, p.stderr[:500]),
                      file=sys.stderr, flush=True)
                sys.exit(1)
            for line in p.stdout.splitlines():
                if not line.strip(): continue
                rec = json.loads(line)
                rec.update(meta.get(rec["name"], {}))
                out.write(json.dumps(rec) + "\n")
        except Exception as e:
            # Same rule as the returncode check: a survey that loses packages
            # without saying so is worse than one that stops.
            print("scan fail", e, file=sys.stderr, flush=True)
            sys.exit(1)
    out.flush()
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)
    print(f"  {i+len(batch)}/{len(names)}", flush=True)
out.close()
shutil.rmtree(WORK, ignore_errors=True)
print("DONE", flush=True)
