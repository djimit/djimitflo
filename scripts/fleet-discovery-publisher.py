#!/usr/bin/env python3
"""G2: publish papers and repositories a fleet agent discovered as discovery.* events on the Djimit event bus.

Scans markdown the agent wrote (Hermes: ~/.hermes/shared/briefings and ~/.hermes/shared/publications) for arXiv abs
links and GitHub repository links, and posts each new one once (state file of sent refs). Djimitflo's
ExternalEventIngest turns identifiable, on-topic ones into expertise units (G1). Stdlib only; run daily (launchd/cron).

  fleet-discovery-publisher.py --agent hermes-macmini --dir ~/.hermes/shared/briefings --dir ~/.hermes/shared/publications [--dry-run]
"""
import argparse, json, os, re, sys, urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ARXIV = re.compile(r'arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})')
GITHUB = re.compile(r'github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)')
# title styles in order of trust: "quoted", **bold**, leading text before a dash
TITLES = [re.compile(r'"([^"]{8,300})"'), re.compile(r'\*\*([^*]{8,300})\*\*'), re.compile(r'\[([^\]]{8,300})\]\(https?://arxiv'), re.compile(r'^[\s\d.•*-]*([^\[\]()]{8,300}?)\s+[–—-]\s')]


def title_of(line):
    return next((m.group(1).strip() for m in (p.search(line) for p in TITLES) if m), '')
CATEGORY = re.compile(r'\b(cs\.[A-Z]{2}|stat\.ML|quant-ph)\b')
NOT_REPOS = {'owner', 'user', 'orgs', 'topics', 'features', 'advisories', 'settings', 'marketplace', 'sponsors', 'apps', 'search', 'collections', 'trending'}


def discoveries(text):
    """Yields (event_type, ref, title, note, categories) per link, in file order."""
    category = None
    for line in text.splitlines():
        if CATEGORY.search(line) and 'arxiv.org' not in line:
            category = CATEGORY.search(line).group(1)
        note = line.strip(' •-*\t')[:1000]
        for m in ARXIV.finditer(line):
            yield 'discovery.paper', f'arxiv:{m.group(1)}', title_of(line), note, [category] if category else []
        for m in GITHUB.finditer(line):
            owner, repo = m.group(1), re.sub(r'(\.git|[.)]+)$', '', m.group(2))
            if owner.lower() in NOT_REPOS or not repo:
                continue
            slug = f'{owner}/{repo}'.lower()
            yield 'discovery.repository', f'github:{slug}', slug, note, []


# G5 scout: Djimitflo's interests (plan G3 measured 17% relevance from general briefings). ponytail: static list; replace
# with the weekly interest profile (topics whose cards won in the gym) once G5 feedback exists.
INTERESTS = ['test generation', 'unit test', 'mutation', 'program repair', 'bug fix', 'code review', 'coding agent',
             'software engineering agent', 'swe-bench', 'agent evaluation', 'llm-as-a-judge', 'tool use', 'context compression',
             'self-improv', 'fault localization', 'regression', 'flaky test', 'static analysis', 'prompt injection']


def rss_discoveries(xml_text, category, interests=INTERESTS):
    """Yields discoveries from an arXiv RSS feed whose title or abstract names one of `interests`."""
    for item in ET.fromstring(xml_text).iter('item'):
        title = (item.findtext('title') or '').strip()
        text = f"{title} {item.findtext('description') or ''}".lower()
        m = ARXIV.search(item.findtext('link') or '')
        hits = [k for k in interests if k in text]
        if m and hits:
            yield 'discovery.paper', f'arxiv:{m.group(1)}', title, f"scout match: {', '.join(hits)}", [category]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--agent', required=True)
    ap.add_argument('--dir', action='append', default=[])
    ap.add_argument('--arxiv-rss', action='append', default=[], help='arXiv category to scout, e.g. cs.SE (G5)')
    ap.add_argument('--bus', default=os.environ.get('DJIMIT_EVENT_BUS_URL', 'http://100.86.47.122:8083'))
    ap.add_argument('--stream', default='djimit.events')
    ap.add_argument('--state', default=str(Path.home() / '.djimit' / 'fleet-discoveries.sent.json'))
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    state = Path(args.state)
    sent = set(json.loads(state.read_text())) if state.exists() else set()
    new = {}
    for d in args.dir:
        for path in sorted(Path(os.path.expanduser(d)).rglob('*.md')):
            for event_type, ref, title, note, categories in discoveries(path.read_text(errors='replace')):
                if ref not in sent and ref not in new:
                    new[ref] = {'event_id': f'discovery:{ref}', 'event_type': event_type, 'source': args.agent, 'agent': args.agent,
                                'ref': ref, 'title': title, 'note': note, 'categories': categories, 'origin_file': path.name,
                                'dedupe_key': f'discovery:{ref}'}
    for cat in args.arxiv_rss:
        try:
            xml_text = urllib.request.urlopen(f'https://rss.arxiv.org/rss/{cat}', timeout=20).read().decode('utf-8', 'replace')
        except Exception as exc:
            print(f'rss {cat} failed: {exc}', file=sys.stderr); continue
        for event_type, ref, title, note, categories in rss_discoveries(xml_text, cat):
            if ref not in sent and ref not in new:
                new[ref] = {'event_id': f'discovery:{ref}', 'event_type': event_type, 'source': args.agent, 'agent': args.agent,
                            'ref': ref, 'title': title, 'note': note, 'categories': categories, 'origin_file': f'rss:{cat}',
                            'dedupe_key': f'discovery:{ref}'}
    posted = 0
    for ref, event in new.items():
        if args.dry_run:
            print(json.dumps(event)); continue
        req = urllib.request.Request(f"{args.bus.rstrip('/')}/events/{args.stream}", json.dumps(event).encode(), {'Content-Type': 'application/json'})
        try:
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as exc:  # keep what was sent; retry the rest next run
            print(f'publish failed at {ref}: {exc}', file=sys.stderr); break
        sent.add(ref); posted += 1
    if not args.dry_run:
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(json.dumps(sorted(sent)))
    print(f'{len(new)} new discoveries, {posted} published', file=sys.stderr)


def selfcheck():
    t = '🔒 cs.CR (Security)\n• "Stress-Testing Malware Graph Networks" — https://arxiv.org/abs/2609.28517\n' \
        '1. **Quantum ROP: Using Quantum Algorithms** – New [arXiv](https://arxiv.org/abs/2609.25364)\n' \
        'Plain Title Of A Paper – text https://arxiv.org/abs/2609.11111\n[Linked Paper Title](https://arxiv.org/abs/2609.22222)\nsee https://github.com/owner/repo and https://github.com/usestrix/strix.\n'
    r = list(discoveries(t))
    assert [x[2] for x in r[:4]] == ['Stress-Testing Malware Graph Networks', 'Quantum ROP: Using Quantum Algorithms', 'Plain Title Of A Paper', 'Linked Paper Title'], r
    assert r[0][4] == ['cs.CR'] and [x[1] for x in r[4:]] == ['github:usestrix/strix'], r
    rss = '<rss><channel><item><title>LLM-based program repair at scale</title><link>https://arxiv.org/abs/2609.33333</link><description>We study bug fix agents.</description></item>' \
          '<item><title>Quantum dots</title><link>https://arxiv.org/abs/2609.44444</link><description>Physics.</description></item></channel></rss>'
    r = list(rss_discoveries(rss, 'cs.SE'))
    assert [x[1] for x in r] == ['arxiv:2609.33333'] and 'program repair' in r[0][3] and r[0][4] == ['cs.SE'], r
    print('selfcheck ok')


if __name__ == '__main__':
    selfcheck() if sys.argv[1:] == ['--selfcheck'] else main()
