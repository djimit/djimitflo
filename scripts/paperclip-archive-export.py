#!/usr/bin/env python3
"""Export readable JSONL from a Paperclip pg_dump (plain SQL, optionally .gz) — no Paperclip login, no database needed.

Only an allowlist of work-history tables is exported (never secrets/api keys/auth tables).
Usage: paperclip-archive-export.py <dump.sql[.gz]> <out_dir>   |   --selftest
Writes <out_dir>/<table>.jsonl plus MANIFEST.json (row counts + sha256 per file).
"""
import gzip, hashlib, json, os, re, sys

ALLOW = {"issues", "issue_comments", "agents", "routines", "routine_runs", "projects", "approvals", "approval_comments",
         "goals", "documents", "document_revisions", "labels", "issue_labels", "companies", "cost_events"}
COPY_RE = re.compile(r'^COPY "public"\."(\w+)" \((.*)\) FROM stdin;$')
ESC = {"t": "\t", "n": "\n", "r": "\r", "\\": "\\", "b": "\b", "f": "\f", "v": "\v"}

def unescape(v):
    if v == r"\N": return None
    return re.sub(r"\\(.)", lambda m: ESC.get(m.group(1), m.group(1)), v) if "\\" in v else v

def export(dump, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    opener = gzip.open if dump.endswith(".gz") else open
    counts, out, cols, table = {}, None, None, None
    with opener(dump, "rt", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if out is None:
                m = COPY_RE.match(line)
                if m and m.group(1) in ALLOW:
                    table = m.group(1); cols = [c.strip('"') for c in m.group(2).split(", ")]
                    out = open(os.path.join(out_dir, table + ".jsonl"), "w", encoding="utf-8"); counts[table] = 0
                continue
            if line == r"\.":
                out.close(); out = None; continue
            row = dict(zip(cols, (unescape(v) for v in line.split("\t"))))
            out.write(json.dumps(row, ensure_ascii=False) + "\n"); counts[table] += 1
    manifest = {}
    for t, n in sorted(counts.items()):
        with open(os.path.join(out_dir, t + ".jsonl"), "rb") as f:
            manifest[t] = {"rows": n, "sha256": hashlib.sha256(f.read()).hexdigest()}
    with open(os.path.join(out_dir, "MANIFEST.json"), "w") as f:
        json.dump({"source": os.path.basename(dump), "tables": manifest}, f, indent=1)
    return counts

def selftest():
    import tempfile
    d = tempfile.mkdtemp(); p = os.path.join(d, "x.sql")
    with open(p, "w") as f:
        f.write('COPY "public"."issues" ("id", "title") FROM stdin;\n1\ta\\tb\n2\t\\N\n\\.\nCOPY "public"."company_secrets" ("id") FROM stdin;\ns\n\\.\n')
    c = export(p, os.path.join(d, "o"))
    assert c == {"issues": 2}, c
    rows = [json.loads(l) for l in open(os.path.join(d, "o", "issues.jsonl"))]
    assert rows == [{"id": "1", "title": "a\tb"}, {"id": "2", "title": None}], rows
    assert not os.path.exists(os.path.join(d, "o", "company_secrets.jsonl"))
    print("selftest ok")

if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]: selftest()
    else: print(export(sys.argv[1], sys.argv[2]))
