---------------------------- MODULE AuditChain ----------------------------
(*
 * TLA+ Specification for Audit Chain
 *
 * Invariant: The audit chain is append-only and tamper-evident.
 * Property: Each entry's hash depends on the previous entry's hash.
 *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Actors,         (* Set of all actors *)
    Actions,        (* Set of all actions *)
    Resources,      (* Set of all resources *)
    MaxEntries      (* Maximum number of audit entries *)

VARIABLES
    entries,        (* sequence of audit entries *)
    merkle_root,    (* current Merkle root hash *)
    anchors         (* set of anchored roots *)

TypeInvariant ==
    /\ entries \in Seq([id: Nat, actor: Actors, action: Actions, resource: Resources, outcome: {"success", "failure", "denied"}, previous_hash: STRING, hash: STRING])
    /\ merkle_root \in STRING
    /\ anchors \in SUBSET STRING

(* Invariant: Append-only *)
(* Entries can only be added, never modified or deleted *)
AppendOnlyInvariant ==
    \A i \in 1..Len(entries) :
        \A j \in (i+1)..Len(entries) :
            entries[j].id > entries[i].id

(* Invariant: Hash chain integrity *)
(* Each entry's previous_hash matches the previous entry's hash *)
HashChainInvariant ==
    \A i \in 2..Len(entries) :
        entries[i].previous_hash = entries[i-1].hash

(* Invariant: Genesis entry *)
(* The first entry has previous_hash = "genesis" *)
GenesisInvariant ==
    Len(entries) > 0 => entries[1].previous_hash = "genesis"

(* Invariant: Merkle root consistency *)
(* The Merkle root is computed from all entry hashes *)
MerkleRootInvariant ==
    merkle_root = ComputeMerkleRoot([i \in 1..Len(entries) |-> entries[i].hash])

(* Invariant: Anchored roots are immutable *)
(* Once a root is anchored, it cannot be changed *)
AnchorImmutabilityInvariant ==
    \A a \in anchors :
        a \in {merkle_root} \cup {e.previous_hash : e \in entries}

(* Helper operators *)
ComputeMerkleRoot(hashes) ==
    IF Len(hashes) = 0 THEN "empty"
    ELSE IF Len(hashes) = 1 THEN hashes[1]
    ELSE
        LET paired == [i \in 1..Len(hashes) |-> IF i <= Len(hashes) THEN hashes[i] ELSE hashes[Len(hashes)]]
            combined == [i \in 1..Ceiling(Len(hashes) / 2) |-> Hash(paired[2*i-1] \o paired[2*i])]
        IN ComputeMerkleRoot(combined)

Hash(data) ==
    (* Simplified hash function for model checking *)
    "hash_" \o ToString(data)

ToString(x) ==
    CASE x OF
        "success" -> "success"
        "failure" -> "failure"
        "denied" -> "denied"
        OTHER -> "other"

Ceiling(n) ==
    IF n \in Nat THEN n ELSE n + 1

(* Actions *)
AppendEntry(actor, action, resource, outcome) ==
    /\ Len(entries) < MaxEntries
    /\ LET entry_id == Len(entries) + 1
           previous_hash == IF Len(entries) = 0 THEN "genesis" ELSE entries[Len(entries)].hash
           entry_hash == Hash([id |-> entry_id, actor |-> actor, action |-> action, resource |-> resource, outcome |-> outcome, previous_hash |-> previous_hash])
       IN /\ entries' = Append(entries, [id |-> entry_id, actor |-> actor, action |-> action, resource |-> resource, outcome |-> outcome, previous_hash |-> previous_hash, hash |-> entry_hash])
          /\ merkle_root' = ComputeMerkleRoot([i \in 1..Len(entries') |-> entries'[i].hash])
    /\ UNCHANGED anchors

AnchorRoot() ==
    /\ Len(entries) > 0
    /\ anchors' = anchors \cup {merkle_root}
    /\ UNCHANGED <<entries, merkle_root>>

(* Safety properties *)
Safety ==
    /\ AppendOnlyInvariant
    /\ HashChainInvariant
    /\ GenesisInvariant
    /\ MerkleRootInvariant
    /\ AnchorImmutabilityInvariant

(* Liveness: Every entry eventually gets anchored *)
Liveness ==
    <>(\A e \in entries :
        e.hash \in anchors)

=============================================================================
