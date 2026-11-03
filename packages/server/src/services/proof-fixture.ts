/**
 * RX-16b: proof runs write test-fixture gap claims (subject_ref 'proof:<id>', prod 03-10: 234 rows = 78 subjects ×3).
 * They are not open questions — no Commons topic and no lure bait may be drawn from them. One shared rule for both.
 */
export const PROOF_SUBJECT_PREFIX = 'proof:';
/** SQL predicate for swarm_claims: true for claims that are not proof-run fixtures. */
export const NOT_PROOF_FIXTURE_SQL = `COALESCE(subject_ref, '') NOT LIKE '${PROOF_SUBJECT_PREFIX}%'`;
