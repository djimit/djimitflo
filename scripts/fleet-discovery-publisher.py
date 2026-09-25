#!/usr/bin/env python3
"""G2: publish papers and repositories a fleet agent discovered as discovery.* events on the Djimit event bus.

Scans markdown the agent wrote (Hermes: ~/.hermes/shared/briefings and ~/.hermes/shared/publications) for arXiv abs
links and GitHub repository links, and posts each new one once (state file of sent refs). Djimitflo's
ExternalEventIngest turns identifiable, on-topic ones into expertise units (G1). Stdlib only; run daily (launchd/cron).

  fleet-discovery-publisher.py --agent hermes-macmini --dir ~/.hermes/shared/briefings --dir ~/.hermes/shared/publications [--dry-run]
"""
import argparse, json, os, re, sys, urllib.request
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--agent', required=True)
    ap.add_argument('--dir', action='append', required=True)
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
    print('selfcheck ok')


if __name__ == '__main__':
    selfcheck() if sys.argv[1:] == ['--selfcheck'] else main()
