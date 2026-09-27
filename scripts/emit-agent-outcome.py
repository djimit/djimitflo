#!/usr/bin/env python3
"""Plan N2: report one unit of agent work to Djimitflo (event `agent.outcome` on the Djimit event bus).

Djimitflo stores it as skill outcome `agent:<agent>:<task_kind>` and ranks agents x models across the fleet.
Stdlib only, Python 3.9-safe (Mac mini). Never raises into the caller: exit 0 even when the bus is down.

  emit-agent-outcome.py --agent hermes-eve-v --task-kind briefing --success true [--model kimi-k3] [--tokens 1200] \
      [--duration-ms 5400] [--ref https://...] [--dry-run]
  emit-agent-outcome.py --selfcheck
"""
import argparse, json, os, sys, time, urllib.request, uuid


def build(agent, task_kind, success, model=None, tokens=None, duration_ms=None, ref=None):
    event = {'event_id': 'agent-outcome:' + str(uuid.uuid4()), 'event_type': 'agent.outcome', 'source': agent, 'agent': agent,
             'task_kind': task_kind, 'success': bool(success), 'occurred_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    if model: event['model'] = model
    if tokens is not None: event['tokens'] = int(tokens)
    if duration_ms is not None: event['duration_ms'] = int(duration_ms)
    if ref: event['ref'] = ref[:300]
    return event


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--agent'); ap.add_argument('--task-kind'); ap.add_argument('--success')
    ap.add_argument('--model'); ap.add_argument('--tokens', type=int); ap.add_argument('--duration-ms', type=int); ap.add_argument('--ref')
    ap.add_argument('--bus', default=os.environ.get('DJIMIT_EVENT_BUS_URL', 'http://100.86.47.122:8083'))
    ap.add_argument('--stream', default='djimit.events')
    ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--selfcheck', action='store_true')
    a = ap.parse_args()
    if a.selfcheck:
        e = build('x', 'y', True, tokens=3)
        assert e['event_type'] == 'agent.outcome' and e['success'] is True and e['tokens'] == 3 and 'model' not in e
        print('selfcheck ok'); return
    if not (a.agent and a.task_kind and a.success in ('true', 'false')):
        ap.error('--agent, --task-kind and --success true|false are required')
    event = build(a.agent, a.task_kind, a.success == 'true', a.model, a.tokens, a.duration_ms, a.ref)
    if a.dry_run:
        print(json.dumps(event)); return
    try:
        req = urllib.request.Request(a.bus.rstrip('/') + '/events/' + a.stream, json.dumps(event).encode(), {'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as err:  # reporting must never break the agent's own work
        print('agent.outcome not sent: ' + str(err), file=sys.stderr)


if __name__ == '__main__':
    main()
