"""Recompute Commons audit conclusions from retained, read-only evidence."""
import collections
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
x = json.loads((ROOT / 'runtime-evidence.json').read_text())
d = json.loads((ROOT / 'diagnostics.json').read_text())
SHA = 'bf6f647c49b70a65ab795b113f512b9c84ca08a1'
assert x['source_sha'] == d['source_sha'] == SHA
assert not any('error' in q for q in x['results'].values())
assert not any('error' in q for q in d['results'].values())
assert 'error' not in x['readers']
def rows(k): return x['results'][k]['rows']
def diag(k): return d['results'][k]['rows']
reviews = diag('review_reasons')
unparsed = [r for r in reviews if 'could not be parsed' in r['findings_json']]
consensus = {r['id']: r['decision'] for r in diag('child_consensus')}
review_breakdown = collections.defaultdict(collections.Counter)
for r in reviews:
    review_breakdown[consensus[r['panel_id']]]['unparseable' if r in unparsed else r['stance']] += 1
children = rows('children')
assert len(children) == 18 and sum(r['goals'] for r in children) == 0
assert len(consensus) == 18 and len(reviews) == 36
assert len(unparsed) == 20 and len({r['panel_id'] for r in unparsed}) == 10
assert x['readers']['stops'] == dict(no_refinement=6, pending_panel=0, panel_failed=0, panel_backlog=3, rejected=15, goal=0, maker=0, outcome=0)
upper = 1 - math.pow(.025, 1/18)
assert abs(upper - x['readers']['yield']['ci'][1]) < 1e-9
cost = rows('model_costs')
total_threads = sum(r['threads'] for r in rows('threads'))
rooms = next(r for r in rows('evidence_room') if r['kind'] == 'summary')
latest = {r['kind']:r['n'] for r in rows('latest50')}
assert total_threads == 1889 and rooms['threads'] == 820
assert latest == {'evidence_room':42, 'other':8}
assert all(r['threads']==14 for r in diag('interest_7d_provenance'))
assert all(r['missing_goal']==635 for r in diag('evidence_room_unknowns') if r['lane']=='evolution-gym')
output = dict(source_sha=SHA,
    conversations=dict(total=total_threads, discussion=1069, evidence_room=820,
        latest_page_record_only_share=latest['evidence_room']/sum(latest.values()),
        gym_share_of_evidence_rooms=rooms['gym']/rooms['n']),
    yield_contract=dict(message_linked_rows=sum(r['n'] for r in rows('commons_proposals')),
        origin_reflection_rows=sum(r['n'] for r in rows('commons_proposals') if r['source']=='reflection'),
        linked_refinement_rows=sum(r['n'] for r in rows('commons_proposals') if r['source']=='refinement'),
        valid_parents=sum(r['proposals'] for r in rows('groundings') if r['decision']=='yes'),
        children=18, goal_links=0, verified=0, zero_of_18_upper95=upper,
        interpretation='No executed child-goal cohort; neither ineffectiveness nor a peer-learning effect can be estimated.'),
    panel_review=dict(rows=len(reviews), unparseable_rows=len(unparsed), affected_panels=len({r['panel_id'] for r in unparsed}),
        by_consensus={k:dict(v) for k,v in review_breakdown.items()},
        interpretation='Historical technical review failure is not substantive rejection. Current parser failure rate unmeasured.'),
    reflections=dict(rows=sum(r['n'] for r in rows('reflections')),
        statuses={r['status']:r['n'] for r in rows('reflections')},
        meaning='Candidate storage, not learned or adopted behavior.'),
    economics=dict(resident_recorded_calls=sum(r['n'] for r in cost), resident_recorded_ok=sum(r['ok'] for r in cost),
        resident_recorded_tokens=sum((r['tokens_in'] or 0)+(r['tokens_out'] or 0) for r in cost),
        rows_with_price_basis=sum(r['with_price_basis'] for r in cost),
        caveat='Historical resident telemetry only; excludes unknown earlier usage, external runtimes and energy. No total bill or ROI.'),
    classifications=dict(current_runtime_mechanics='VERIFIED within stated tests/read-only evidence',
        peer_learning_benefit='UNVERIFIED', cumulative_gain='UNVERIFIED',
        proposed_interventions='INFERRED hypotheses awaiting controlled evaluation'))
(ROOT/'analysis.json').write_text(json.dumps(output,indent=2)+'\n')
print(json.dumps(output,indent=2))
