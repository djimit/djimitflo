#!/usr/bin/env python3
"""Skill inventory 2026-10-26, intervention 1: one signed `agent.outcome` per finished Hermes cron run x declared skill.

Run on a Hermes host every 15 min (user crontab). Reads, never writes, the Hermes cron state:
  <hermes-home>/cron/jobs.json       job id -> name and declared skills (`skills`, else `skill`)
  <hermes-home>/cron/executions.db   one row per run (opened read-only): status completed | failed | claimed | running | unknown
  <hermes-home>/skills/**/<skill>/SKILL.md   the installed skill, hashed with the emitter's normalisation
Success is the run's recorded status: completed -> true, failed -> false. A run with any other status (still running, or
`unknown`) has no real result, so nothing is emitted for it and it is counted under `no_status`.

The skill hash is taken when this script runs, not when the run started. Hermes skills patch themselves, so when SKILL.md
changed after the run started (mtime > started_at) the installed file is not the one the run used: the event then carries
the skill name without skill_sha (null, never a guess). A missing or ambiguous SKILL.md also gives no skill_sha.

Idempotent twice over: the event_id is deterministic (agent-outcome:hermes-cron:<agent>:<execution id>:<skill>, so the
Djimitflo ingest's INSERT OR IGNORE drops a re-post), and the state file remembers emitted execution ids (kept 7 days).
Only runs that finished within --max-age-h (default 20) are emitted: a signed event is verified within 24 h of occurred_at
(= the run's finished_at), anything older would be refused under FLEET_EVENT_SIGNATURES=enforce.
Hermes keeps the last 1000 executions; on a host where a minutely job fills that window, runs stay visible for ~40 h.

Stdlib only, Python 3.9-safe. Signing, hashing and the POST come from emit-agent-outcome.py next to this file.

  hermes-cron-outcomes.py --agent hermes-eve-v [--hermes-home ~/.hermes] [--state FILE] [--dry-run]
  hermes-cron-outcomes.py --selfcheck
"""
import argparse, glob, importlib.util, json, os, re, sqlite3, sys, tempfile, time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_KEEP_S = 7 * 86400


def load_emitter(path=os.path.join(HERE, 'emit-agent-outcome.py')):
    spec = importlib.util.spec_from_file_location('emit_agent_outcome', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def parse_ts(value):
    """Hermes timestamps are ISO 8601 with offset ('2026-10-26T18:02:36.341438+01:00'); epoch seconds or None."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def utc_z(epoch):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(epoch))


def task_kind(job_name, job_id):
    slug = re.sub(r'[^a-z0-9_.-]+', '-', (job_name or job_id).lower()).strip('-')[:58] or job_id
    return 'cron:' + slug


def declared_jobs(home):
    """{job_id: (name, [skills])} for jobs that declare at least one skill."""
    with open(os.path.join(home, 'cron', 'jobs.json')) as f:
        data = json.load(f)
    jobs = data.get('jobs', []) if isinstance(data, dict) else data
    out = {}
    for j in jobs:
        skills = j.get('skills') or ([j['skill']] if j.get('skill') else [])
        skills = [s for s in skills if isinstance(s, str) and s]
        if j.get('id') and skills:
            out[j['id']] = (j.get('name') or j['id'], list(dict.fromkeys(skills)))
    return out


def skill_file(home, skill):
    """The one installed SKILL.md for a skill, or (None, reason). Hidden dirs (archives, curator backups) are not searched."""
    hits = sorted(glob.glob(os.path.join(home, 'skills', '**', skill, 'SKILL.md'), recursive=True))
    if not hits:
        return None, 'missing'
    if len(hits) > 1:
        return None, 'ambiguous'
    return hits[0], None


def open_ro(path):
    """Read-only open that never writes next to Hermes' DB. executions.db is in WAL mode: while the gateway has it open the
    -wal/-shm files exist and mode=ro works; when it is closed there is no -shm, mode=ro cannot create one and fails, and the
    file is then complete on its own, so immutable=1 (no locking, no WAL) reads it exactly."""
    if not os.path.exists(path):
        raise OSError('no such file: ' + path)
    try:
        con = sqlite3.connect('file:' + path + '?mode=ro', uri=True)
        con.execute('SELECT 1 FROM executions LIMIT 1')
        return con
    except sqlite3.OperationalError:
        if os.path.exists(path + '-wal'):
            raise
        return sqlite3.connect('file:' + path + '?mode=ro&immutable=1', uri=True)


def finished_runs(home, job_ids):
    if not job_ids:
        return []
    con = open_ro(os.path.join(home, 'cron', 'executions.db'))
    try:
        marks = ','.join('?' * len(job_ids))
        return con.execute('SELECT id, job_id, status, started_at, finished_at FROM executions WHERE job_id IN (%s) '
                           'ORDER BY claimed_at, id' % marks, list(job_ids)).fetchall()
    finally:
        con.close()


def load_state(path):
    try:
        with open(path) as f:
            state = json.load(f)
        return state if isinstance(state, dict) and isinstance(state.get('emitted'), dict) else {'emitted': {}}
    except (OSError, ValueError):
        return {'emitted': {}}


def save_state(path, state, now):
    state['emitted'] = {k: v for k, v in state['emitted'].items() if now - v < STATE_KEEP_S}
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix='.hermes-cron-outcomes.')
    with os.fdopen(fd, 'w') as f:
        json.dump(state, f, sort_keys=True)
    os.replace(tmp, path)


def collect(home, agent, emitter, state, now, max_age_s, key=None):
    """(events to send as [(execution_id, event)], report). Pure apart from reading the Hermes files."""
    jobs = declared_jobs(home)
    report = {'jobs': {jid: {'name': n, 'skills': s, 'emit': 0} for jid, (n, s) in jobs.items()},
              'events': 0, 'already_emitted': 0, 'too_old': 0, 'no_status': 0, 'unhashed': {}}
    files = {}
    for _, skills in jobs.values():
        for s in skills:
            if s not in files:
                files[s] = skill_file(home, s)
    out = []
    for exec_id, job_id, status, started_at, finished_at in finished_runs(home, jobs.keys()):
        if exec_id in state['emitted']:
            report['already_emitted'] += 1; continue
        if status not in ('completed', 'failed'):
            report['no_status'] += 1; continue
        done, start = parse_ts(finished_at), parse_ts(started_at)
        if done is None:
            report['no_status'] += 1; continue
        if now - done > max_age_s:
            report['too_old'] += 1; continue
        name, skills = jobs[job_id]
        for skill in skills:
            path, why = files[skill]
            sha = None
            if path:
                try:
                    changed = start is None or os.path.getmtime(path) > start
                except OSError:
                    changed, why = True, 'unreadable'
                if changed:
                    why = why or 'changed-since-run'
                else:
                    sha = emitter.skill_sha256(path)
                    why = None if sha else 'unreadable'
            if why:
                report['unhashed'][skill + ':' + why] = report['unhashed'].get(skill + ':' + why, 0) + 1
            e = emitter.build(agent, task_kind(name, job_id), status == 'completed', ref='hermes-cron:%s:%s' % (job_id, exec_id),
                              duration_ms=int((done - start) * 1000) if start is not None and done >= start else None,
                              skill=skill, skill_sha=sha)
            e['event_id'] = 'agent-outcome:hermes-cron:%s:%s:%s' % (agent, exec_id, skill)
            e['occurred_at'] = utc_z(done)
            if key:
                emitter.sign(e, *key)
            out.append((exec_id, e))
        report['jobs'][job_id]['emit'] += 1
    report['events'] = len(out)
    return out, report


def run(a, emitter):
    home = os.path.expanduser(a.hermes_home)
    state_path = os.path.expanduser(a.state)
    now = time.time()
    state = load_state(state_path)
    key = emitter.load_key()
    events, report = collect(home, a.agent, emitter, state, now, a.max_age_h * 3600, key)
    report['signed'] = bool(key)
    if a.dry_run:
        for _, e in events:
            print(json.dumps(e))
        print(json.dumps({'dry_run': True, **report}, sort_keys=True)); return 0
    failed = set()
    for exec_id, e in events:
        if not emitter.send(e, a.bus, a.stream):
            failed.add(exec_id)
    for exec_id, _ in events:
        if exec_id not in failed:
            state['emitted'][exec_id] = now
    save_state(state_path, state, now)
    report['send_failed_runs'] = len(failed)
    print(json.dumps(report, sort_keys=True))
    return 0


def selfcheck(emitter):
    d = tempfile.mkdtemp()
    home = os.path.join(d, 'hermes')
    os.makedirs(os.path.join(home, 'cron'))
    for rel in ('productivity/blog-publisher', 'consulting/eve-daily-content-intelligence', 'a/dup', 'b/dup'):
        os.makedirs(os.path.join(home, 'skills', rel))
        with open(os.path.join(home, 'skills', rel, 'SKILL.md'), 'w') as f:
            f.write('---\nname: %s\n---\nbody\n' % rel)
    os.makedirs(os.path.join(home, 'skills', '.archive', 'blog-publisher'))  # hidden copies are ignored
    open(os.path.join(home, 'skills', '.archive', 'blog-publisher', 'SKILL.md'), 'w').close()
    with open(os.path.join(home, 'cron', 'jobs.json'), 'w') as f:
        json.dump({'jobs': [
            {'id': 'j1', 'name': 'content-intelligence-briefing', 'skill': 'eve-daily-content-intelligence',
             'skills': ['eve-daily-content-intelligence', 'blog-publisher']},
            {'id': 'j2', 'name': 'DjimIT Ochtendbriefing', 'skill': 'dup'},
            {'id': 'j3', 'name': 'no-skill', 'skills': []},
        ]}, f)
    now = time.time()
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).astimezone().isoformat()
    con = sqlite3.connect(os.path.join(home, 'cron', 'executions.db'))
    con.execute('PRAGMA journal_mode=wal')  # like Hermes; closed, it leaves no -shm, so this also covers open_ro's fallback
    con.execute('CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT, status TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT)')
    rows = [('e-ok', 'j1', 'completed', now - 600, now - 500), ('e-fail', 'j1', 'failed', now - 400, now - 300),
            ('e-run', 'j1', 'running', now - 60, None), ('e-unk', 'j1', 'unknown', now - 900, now - 800),
            ('e-old', 'j1', 'completed', now - 30 * 3600, now - 29 * 3600), ('e-dup', 'j2', 'completed', now - 200, now - 100),
            ('e-none', 'j3', 'completed', now - 200, now - 100)]
    for i, j, s, st, fi in rows:
        con.execute('INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?)', (i, j, s, iso(st), iso(st), iso(fi) if fi else None))
    con.commit(); con.close()
    for side in ('-wal', '-shm'):  # checkpointed on close; Linux removes them, macOS' SQLite may keep them: drop them like Linux
        if os.path.exists(os.path.join(home, 'cron', 'executions.db' + side)):
            os.remove(os.path.join(home, 'cron', 'executions.db' + side))
    old = now - 3600  # the skill files predate every run, except where the test touches them
    for root, _, names in os.walk(os.path.join(home, 'skills')):
        for n in names:
            os.utime(os.path.join(root, n), (old, old))
    state = {'emitted': {}}
    events, rep = collect(home, 'hermes-eve-v', emitter, state, now, 20 * 3600, ('eve-v', '0123456789abcdef', 'fixture-secret'))
    by_id = dict((e['event_id'], e) for _, e in events)
    assert sorted(by_id) == sorted('agent-outcome:hermes-cron:hermes-eve-v:%s' % k for k in (
        'e-ok:eve-daily-content-intelligence', 'e-ok:blog-publisher', 'e-fail:eve-daily-content-intelligence',
        'e-fail:blog-publisher', 'e-dup:dup')), sorted(by_id)
    ok = by_id['agent-outcome:hermes-cron:hermes-eve-v:e-ok:blog-publisher']
    assert ok['success'] is True and ok['task_kind'] == 'cron:content-intelligence-briefing' and ok['skill'] == 'blog-publisher'
    assert ok['skill_sha'] == emitter.skill_sha256(os.path.join(home, 'skills', 'productivity', 'blog-publisher', 'SKILL.md'))
    assert ok['duration_ms'] == 100000 and ok['sig'] and ok['host'] == 'eve-v' and ok['occurred_at'].endswith('Z')
    assert by_id['agent-outcome:hermes-cron:hermes-eve-v:e-fail:blog-publisher']['success'] is False
    assert 'skill_sha' not in by_id['agent-outcome:hermes-cron:hermes-eve-v:e-dup:dup']  # two installed copies: no guess
    assert rep['no_status'] == 2 and rep['too_old'] == 1 and rep['unhashed'] == {'dup:ambiguous': 1}, rep
    assert rep['jobs']['j1']['emit'] == 2 and 'j3' not in rep['jobs']
    # second pass after the first was recorded: nothing new
    for exec_id, _ in events:
        state['emitted'][exec_id] = now
    again, rep2 = collect(home, 'hermes-eve-v', emitter, state, now, 20 * 3600)
    assert again == [] and rep2['already_emitted'] == 3, rep2
    # a skill patched after the run started: name kept, hash withheld
    os.utime(os.path.join(home, 'skills', 'productivity', 'blog-publisher', 'SKILL.md'), None)
    fresh, rep3 = collect(home, 'hermes-eve-v', emitter, {'emitted': {}}, now, 20 * 3600)
    patched = [e for _, e in fresh if e['skill'] == 'blog-publisher']
    assert patched and all('skill_sha' not in e for e in patched) and rep3['unhashed']['blog-publisher:changed-since-run'] == 2, rep3
    # state round trip prunes entries older than 7 days
    sp = os.path.join(d, 'state', 's.json')
    save_state(sp, {'emitted': {'keep': now, 'drop': now - 8 * 86400}}, now)
    assert set(load_state(sp)['emitted']) == {'keep'} and load_state(os.path.join(d, 'nope.json')) == {'emitted': {}}
    for root, dirs, names in os.walk(d, topdown=False):
        for n in names: os.remove(os.path.join(root, n))
        for n in dirs: os.rmdir(os.path.join(root, n))
    os.rmdir(d)
    print('selfcheck ok')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--agent', help='fleet agent name, e.g. hermes-eve-v')
    ap.add_argument('--hermes-home', default='~/.hermes')
    ap.add_argument('--state', default='~/.djimit/hermes-cron-outcomes.state.json')
    ap.add_argument('--max-age-h', type=float, default=20.0)
    ap.add_argument('--bus', default=os.environ.get('DJIMIT_EVENT_BUS_URL', 'http://100.86.47.122:8083'))
    ap.add_argument('--stream', default='djimit.events')
    ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--selfcheck', action='store_true')
    a = ap.parse_args()
    emitter = load_emitter()
    if a.selfcheck:
        selfcheck(emitter); return 0
    if not a.agent or not re.match(r'^[\w.-]{1,64}$', a.agent):
        ap.error('--agent <name> is required ([A-Za-z0-9_.-]{1,64})')
    try:
        return run(a, emitter)
    except (OSError, ValueError, sqlite3.Error) as err:  # a broken Hermes state is reported, never half-emitted
        print(json.dumps({'error': str(err)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
