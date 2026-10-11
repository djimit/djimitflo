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
# title styles in order of trust: [link text](arxiv link), then in the text before the first link: "quoted", **bold**,
# leading text before a dash. Eve-V (09-10) writes URL-only lines and Dutch descriptions: a quote from the description
# ("ze testen mijn capaciteiten") or the URL itself became the title. Only the text before the link counts, URL-like
# candidates are dropped, a Dutch/English lead-in ("Nieuw paper:") is cut; no title left = the caller uses the arXiv id.
LINK_TITLE = re.compile(r'\[([^\]]{8,300})\]\((?:https?://)?(?:www\.)?arxiv')
TITLES = [re.compile(r'"([^"]{8,300})"'), re.compile(r'\*\*([^*]{8,300})\*\*'), re.compile(r'^[\s\d.\u2022*-]*([^\[\]()]{8,300}?)\s+[\u2013\u2014-]\s')]
URL_LIKE = re.compile(r'https?://|arxiv\.org|github\.com|^\S+/\S+$|^arxiv[\s:]*\d', re.I)
LEAD_IN = re.compile(r'^(?:nieuwe?\s+)?(?:paper|artikel|studie|onderzoek|publicatie|preprint|new paper|bron|link)\s*:\s*', re.I)
FIRST_LINK = re.compile(r'\[[^\]]*\]\(|https?://|(?:www\.)?(?:arxiv\.org|github\.com)/')


def title_of(line):
    head = line[:FIRST_LINK.search(line).start()] if FIRST_LINK.search(line) else line
    found = [m.group(1) for m in [LINK_TITLE.search(line)] if m] + [m.group(1) for m in (p.search(head) for p in TITLES) if m]
    for cand in found:
        cand = LEAD_IN.sub('', cand.strip(' *\t')).strip()
        if len(cand) >= 8 and not URL_LIKE.search(cand):
            return cand
    return ''


CATEGORY = re.compile(r'\b(cs\.[A-Z]{2}|stat\.ML|quant-ph)\b')
NOT_REPOS = {'owner', 'user', 'orgs', 'topics', 'features', 'advisories', 'settings', 'marketplace', 'sponsors', 'apps', 'search', 'collections', 'trending'}


def discoveries(text):
    """Yields (event_type, ref, title, note, categories) per link, in file order."""
    category = None
    for line in text.splitlines():
        if CATEGORY.search(line) and 'arxiv.org' not in line:
            category = CATEGORY.search(line).group(1)
        note = line.strip(' •-*\t')[:1000]
        for pid in dict.fromkeys(m.group(1) for m in ARXIV.finditer(line)):  # "[arxiv.org/abs/X](https://arxiv.org/abs/X)" names X twice
            yield 'discovery.paper', f'arxiv:{pid}', title_of(line) or f'arXiv {pid}', note, [category] if category else []
        for m in GITHUB.finditer(line):
            owner, repo = m.group(1), re.sub(r'(\.git|[.)]+)$', '', m.group(2))
            if owner.lower() in NOT_REPOS or not repo:
                continue
            slug = f'{owner}/{repo}'.lower()
            yield 'discovery.repository', f'github:{slug}', slug, note, []


# G5 scout: Djimitflo's interests (plan G3 measured 17% relevance from general briefings). --interests-from-bus adds the
# terms of Djimitflo's latest `djimitflo.feedback.interests` profile (N4) to this static list.
INTERESTS = ['test generation', 'unit test', 'mutation', 'program repair', 'bug fix', 'code review', 'coding agent',
             'software engineering agent', 'swe-bench', 'agent evaluation', 'llm-as-a-judge', 'tool use', 'context compression',
             'self-improv', 'fault localization', 'regression', 'flaky test', 'static analysis', 'prompt injection']


def feedback_terms(events):
    """N4: terms of the newest djimitflo.feedback.interests event (bus is newest-first; Redis returns fields as strings)."""
    for event in events:
        if isinstance(event, dict) and event.get('event_type') == 'djimitflo.feedback.interests':
            terms = event.get('terms') or []
            if isinstance(terms, str):
                try:
                    terms = json.loads(terms)
                except ValueError:
                    terms = terms.split(',')
            return [str(t).strip().lower() for t in terms if str(t).strip()]
    return []


def rss_discoveries(xml_text, category, interests=INTERESTS):
    """Yields discoveries from an arXiv RSS feed whose title or abstract names one of `interests`."""
    for item in ET.fromstring(xml_text).iter('item'):
        title = (item.findtext('title') or '').strip()
        text = f"{title} {item.findtext('description') or ''}".lower()
        m = ARXIV.search(item.findtext('link') or '')
        hits = [k for k in interests if k in text]
        if m and hits:
            yield 'discovery.paper', f'arxiv:{m.group(1)}', title, f"scout match: {', '.join(hits)}", [category]


def hf_daily_discoveries(papers, interests=INTERESTS):
    """J1: Hugging Face Daily Papers (curated, community upvotes, linked code). Yields discoveries naming an interest."""
    for item in papers:
        p = item.get('paper') or {}
        pid, title = str(p.get('id') or ''), str(p.get('title') or item.get('title') or '').strip()
        text = f"{title} {p.get('summary') or item.get('summary') or ''}".lower()
        hits = [k for k in interests if k in text]
        if not re.fullmatch(r'\d{4}\.\d{4,5}', pid) or not hits:
            continue
        repo = p.get('githubRepo') or item.get('githubRepo')
        note = f"hf daily: {p.get('upvotes', 0)} upvotes; match: {', '.join(hits)}" + (f"; code: {repo}" if repo else '')
        yield 'discovery.paper', f'arxiv:{pid}', title, note, []
        m = GITHUB.search(repo or '')
        if m:
            name = re.sub(r'(\.git|[.)]+)$', '', m.group(2))  # no backslash inside f-strings: python < 3.12 on the Mac mini
            slug = f'{m.group(1)}/{name}'.lower()
            yield 'discovery.repository', f'github:{slug}', slug, f'code for arxiv:{pid} ({title[:80]})', []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--agent', required=True)
    ap.add_argument('--dir', action='append', default=[])
    ap.add_argument('--arxiv-rss', action='append', default=[], help='arXiv category to scout, e.g. cs.SE (G5)')
    ap.add_argument('--hf-daily', action='store_true', help='scout Hugging Face Daily Papers (J1)')
    ap.add_argument('--interests-from-bus', action='store_true', help="add Djimitflo's interest profile to the scout terms (N4)")
    ap.add_argument('--bus', default=os.environ.get('DJIMIT_EVENT_BUS_URL', 'http://100.86.47.122:8083'))
    ap.add_argument('--stream', default='djimit.events')
    ap.add_argument('--state', default=str(Path.home() / '.djimit' / 'fleet-discoveries.sent.json'))
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    interests = list(INTERESTS)
    if args.interests_from_bus:
        try:
            body = json.loads(urllib.request.urlopen(f"{args.bus.rstrip('/')}/events/{args.stream}?count=5000", timeout=20).read())
            extra = [t for t in feedback_terms(body.get('events') or []) if t not in interests]
            interests += extra
            print(f'interest profile: +{len(extra)} terms {extra}', file=sys.stderr)
        except Exception as exc:
            print(f'interest profile unavailable: {exc}', file=sys.stderr)
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
        for event_type, ref, title, note, categories in rss_discoveries(xml_text, cat, interests):
            if ref not in sent and ref not in new:
                new[ref] = {'event_id': f'discovery:{ref}', 'event_type': event_type, 'source': args.agent, 'agent': args.agent,
                            'ref': ref, 'title': title, 'note': note, 'categories': categories, 'origin_file': f'rss:{cat}',
                            'dedupe_key': f'discovery:{ref}'}
    if args.hf_daily:
        try:
            papers = json.loads(urllib.request.urlopen('https://huggingface.co/api/daily_papers?limit=100', timeout=20).read())
        except Exception as exc:
            papers = []; print(f'hf daily failed: {exc}', file=sys.stderr)
        for event_type, ref, title, note, categories in hf_daily_discoveries(papers, interests):
            if ref not in sent and ref not in new:
                new[ref] = {'event_id': f'discovery:{ref}', 'event_type': event_type, 'source': args.agent, 'agent': args.agent,
                            'ref': ref, 'title': title, 'note': note, 'categories': categories, 'origin_file': 'hf:daily_papers',
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
    hf = [{'paper': {'id': '2609.30233', 'title': 'Coding agents for planning', 'summary': 'A coding agent that writes unit test code.', 'upvotes': 9, 'githubRepo': 'https://github.com/tomsilver/robocode'}},
          {'paper': {'id': '2609.11111', 'title': 'World models for video', 'summary': 'frames', 'upvotes': 200}}]
    h = list(hf_daily_discoveries(hf))
    assert [x[1] for x in h] == ['arxiv:2609.30233', 'github:tomsilver/robocode'] and '9 upvotes' in h[0][3], h
    bus = [{'event_type': 'x'}, {'event_type': 'djimitflo.feedback.interests', 'terms': '["Agents","coding"]'},
           {'event_type': 'djimitflo.feedback.interests', 'terms': 'old'}]
    assert feedback_terms(bus) == ['agents', 'coding'] and feedback_terms([{'event_type': 'djimitflo.feedback.interests', 'terms': 'a,b'}]) == ['a', 'b']
    # Eve-V (prod 09-10): URL-only lines and Dutch descriptions; the title must not be the URL or a quote from the description
    eve = '- [arxiv.org/abs/2608.30510](https://arxiv.org/abs/2608.30510)\n' \
          '- https://arxiv.org/abs/2608.27340** \u2014 Toont aan dat eval-awareness geen uniforme eigenschap is: capabilities-framing ("ze testen mijn capaciteiten") voorspelt compliance\n' \
          '- https://arxiv.org/abs/2608.27009** \u2014 Construeert Cautious Bench, het eerste benchmark voor over-safety\n' \
          '- **[When Symmetry Suppresses Magic](https://arxiv.org/abs/2609.38276)** \u2013 toont hoe symmetrische constraint-designs werken\n' \
          '- **AI-governance in een verdeelde wereld** \u2013 analyse. *[Architecture Without an Architect? Global Governance of AI](https://arxiv.org/abs/2610.01111)*\n' \
          '- Nieuw paper: Agentic test repair at scale \u2013 zie https://arxiv.org/abs/2610.02222\n'
    e = list(discoveries(eve))
    assert [x[2] for x in e] == ['arXiv 2608.30510', 'arXiv 2608.27340', 'arXiv 2608.27009', 'When Symmetry Suppresses Magic',
                                 'Architecture Without an Architect? Global Governance of AI', 'Agentic test repair at scale'], e
    assert 'ze testen mijn capaciteiten' in e[1][3], e
    print('selfcheck ok')


if __name__ == '__main__':
    selfcheck() if sys.argv[1:] == ['--selfcheck'] else main()
