#!/usr/bin/env python3
"""CAUSAL-EVOLUTION-003 offline analysis. Standard library only; no model call, no prod access.

usage: python3 probes/analysis.py [path/to/mfr-001/results.json]
  data/graded-labels.json   derived from probes/p1-graded-labels.js (prod, read-only)
  data/contest-graded.json  derived from probes/p6-contest-graded.js
  data/genome-history.json  derived from probes/p2/p3 (epoch-1 trial outcomes deliberately excluded)
  results.json              MFR-001 raw results (#959, docs/research/eco/mfr-001/results.json)
Seeds are fixed, so every number in B_FITNESS_VALIDITY.md and A_MECHANISM.md is reproducible.
"""
import json, math, random, statistics as st, sys, os, re
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
load = lambda n: json.load(open(os.path.join(DATA, n)))


def boot_mean_diff(a, b, B=20000, seed=20261022):
    rnd = random.Random(seed); ds = []
    for _ in range(B):
        x = [rnd.choice(a) for _ in a]; y = [rnd.choice(b) for _ in b]
        ds.append(sum(x) / len(x) - sum(y) / len(y))
    ds.sort(); return ds[int(.025 * B)], ds[int(.975 * B)]


def perm_p(a, b, B=20000, seed=7):
    rnd = random.Random(seed); obs = st.mean(a) - st.mean(b); pool = a + b; hits = 0
    for _ in range(B):
        rnd.shuffle(pool)
        if abs(st.mean(pool[:len(a)]) - st.mean(pool[len(a):])) >= abs(obs) - 1e-12: hits += 1
    return hits / B


def pear(x, y):
    mx, my = st.mean(x), st.mean(y)
    sx = math.sqrt(sum((a - mx) ** 2 for a in x)); sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy) if sx and sy else float('nan')


def boot_r(pairs, B=10000, seed=7):
    rnd = random.Random(seed); rs = []
    for _ in range(B):
        s = [rnd.choice(pairs) for _ in pairs]; r = pear([a for a, _ in s], [b for _, b in s])
        if r == r: rs.append(r)
    rs.sort(); return rs[int(.025 * len(rs))], rs[int(.975 * len(rs))]


def section(t): print(f'\n== {t}')


# ---- B1: verified vs not verified on graded mutant kill -------------------------------------------------------------
g = load('graded-labels.json'); rows = [r for r in g['rows'] if r['kind'] == 'mutant_kill']
section('B1 graded mutant_kill by proposal label (population: completed maker leases with a graded score)')
V = [r['score'] for r in rows if r['sstatus'] == 'verified']; N = [r['score'] for r in rows if r['sstatus'] != 'verified']
lo, hi = boot_mean_diff(V, N)
print(f'verified n={len(V)} mean={st.mean(V):.3f} | not verified n={len(N)} mean={st.mean(N):.3f} | diff={st.mean(V)-st.mean(N):+.3f} '
      f'95% bootstrap CI [{lo:+.3f}, {hi:+.3f}] | permutation p={perm_p(V, N):.3f}')
sd = st.pstdev(V + N); se = sd * math.sqrt(1 / len(V) + 1 / len(N))
print(f'pooled SD {sd:.3f}; SE {se:.3f}; MDE (alpha .05 two-sided, power .8) = {2.80*se:.3f}')
print('label of the not-verified rows:', Counter(r['sstatus'] for r in rows if r['sstatus'] != 'verified'),
      '| run status:', Counter(r['rstatus'] for r in rows if r['sstatus'] != 'verified'))
print('non-accepted reviewer verdicts on not-verified rows:',
      Counter(tuple(sorted({c.split(':', 2)[2] for c in r['checkers'] if not c.endswith(':accepted')})) for r in rows if r['sstatus'] != 'verified'))
print('score distribution verified:', sorted(Counter(V).items()), '| not verified:', sorted(Counter(N).items()))
for sp in ('opencode', 'remote-atomic'):
    for lab in ('verified', 'regressed'):
        x = [r['score'] for r in rows if r['species'] == sp and r['sstatus'] == lab]
        print(f'  {sp:14s} {lab:9s} n={len(x):2d} mean={st.mean(x):.3f}' if x else f'  {sp} {lab} n=0')
print('assertion-strength (shadow) verdicts in this population:', Counter(r['assertion_strength_shadow'] for r in rows))
print('test:mutation:grounded status on exports/test-gap rows (no-op without MUTATE_FILE):', Counter(r['mutation_grounded_check'] for r in rows))
z = [r for r in rows if r['score'] == 0]
print(f'zero-kill tests: {len(z)}/{len(rows)}, of which verified {sum(r["sstatus"]=="verified" for r in z)}; assertion-strength verdicts on them: '
      f'{dict(Counter(r["assertion_strength_shadow"] for r in z))}')
dl = [(r['diff_lines'], r['score']) for r in rows if r['diff_lines']]
print(f'corr(diff lines, graded) = {pear(*zip(*dl)):.3f} (n {len(dl)})')
print('selection into the graded population (lane|graded?|label -> n):')
for k, v in sorted(g['selection_into_graded'].items()): print('   ', k, v)

# ---- B2: reliability of a 3-mutant kill share (MFR-001 raw data) ----------------------------------------------------
mfr = sys.argv[1] if len(sys.argv) > 1 else None
if mfr and os.path.exists(mfr):
    section('B2 parallel-forms reliability of a k=3 kill share (MFR-001 items, never-shown mutant sets)')
    its = [i for i in json.load(open(mfr))['items'] if i.get('eligible') and i.get('original')]
    P = [i['original']['prod_killed'] / 3 for i in its]; S = [len(i['original']['shown_killed']) / 3 for i in its]
    H = [i['original']['held_kill'] for i in its]
    C = [(i['runs']['control']['shown_kill'], i['runs']['control']['held_score']) for i in its if i['runs']['control'].get('class') == 'ok']
    for name, pairs in (('original test: S vs H (two fresh random 3-sets)', list(zip(S, H))),
                        ('original test: P (prod graded set) vs H', list(zip(P, H))),
                        ('control retry: S vs H (neither shown)', C)):
        lo, hi = boot_r(pairs); r = pear(*zip(*pairs))
        sem = math.sqrt(st.mean([(a - b) ** 2 / 2 for a, b in pairs]))
        print(f'{name:48s} n={len(pairs)} r={r:.3f} [{lo:.3f}, {hi:.3f}]  SEM per score={sem:.3f}')
        for target in (0.8, 0.9):
            m = target * (1 - r) / (r * (1 - target)); print(f'      Spearman-Brown: ~{3*m:.0f} mutants for reliability {target}')
    print('P is range-restricted (MFR items have prod graded < 1), which attenuates r(P,H); S and H are unrestricted random splits.')
else:
    print('\n(B2 skipped: pass the MFR-001 results.json path)')

# ---- B3: graded evolve contest (selection) --------------------------------------------------------------------------
section('B3 graded evolve contest (shadow): how much selection would change')
cs = load('contest-graded.json')['contests']; scored = [c for c in cs if c['scores']]
ties = sum(len(set(c['scores'])) == 1 for c in scored)
cur = [c['current_winner_score'] for c in scored]; gr = [c['graded_winner_score'] for c in scored]
print(f'contests {len(cs)}, scored {len(scored)}, all siblings tied {ties}, disagreements {sum(not c["agree"] for c in cs)}; '
      f'mean graded of size-rule winner {st.mean(cur):.3f} vs graded winner {st.mean(gr):.3f} (gain {st.mean(gr)-st.mean(cur):+.3f})')

# ---- A1: pooled genome trials (epoch 0 only; epoch-1 trials are registered and excluded) -----------------------------
section('A1 pooled paired outcome of the 10 settled epoch-0 genome trials (from maker_genomes notes)')
gh = load('genome-history.json')['genomes']; b = c = n = 0; per = []
for x in gh:
    note = x['note'] or ''
    m = re.match(r'holdout (\d+)/(\d+) vs parent (\d+)/\d+', note)
    if not m: continue
    ds = [tuple(map(int, d)) for d in re.findall(r'discordant (\d+) vs (\d+)', note)]
    bb = sum(d[0] for d in ds); cc = sum(d[1] for d in ds)
    b += bb; c += cc; n += int(m.group(2)); per.append((x['id'], int(m.group(1)), int(m.group(3)), int(m.group(2)), bb, cc))
for p in per: print(f'  {p[0]} mutant {p[1]}/{p[3]} parent {p[2]}/{p[3]} wins {p[4]} losses {p[5]}')
d = (b - c) / n; se = math.sqrt(b + c - (b - c) ** 2 / n) / n
print(f'pooled: wins b={b}, losses c={c}, paired task-observations n={n}; mean paired diff {d:+.4f}, '
      f'normal-approx 95% CI [{d-1.96*se:+.4f}, {d+1.96*se:+.4f}] (ignores the shared parent and task clustering)')
lineages = Counter(x['parent_id'] for x in gh if x['origin'] == 'dream')
print('parents of dream genomes:', dict(lineages), '-> generations beyond the first:', sum(v for k, v in lineages.items() if k != 'baseline'))
print('status:', Counter(x['status'] for x in gh))
