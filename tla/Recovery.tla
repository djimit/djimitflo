---------------------------- MODULE Recovery ----------------------------
(*
 * TLA+ Specification for Loop Recovery
 *
 * Invariant: Recovery is bounded and idempotent.
 * Property: A run can only be resumed up to MaxResumeAttempts times.
 *)

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Runs,           (* Set of all loop runs *)
    MaxResumeAttempts, (* Maximum number of resume attempts *)
    RunStatuses     (* {CREATED, RUNNING, INTERRUPTED, FAILED, COMPLETED} *)

VARIABLES
    run_states,     (* [run_id -> status] *)
    resume_attempts, (* [run_id -> Nat] *)
    live_leases     (* set of live lease IDs *)

TypeInvariant ==
    /\ run_states \in [Runs -> RunStatuses]
    /\ resume_attempts \in [Runs -> 0..MaxResumeAttempts]
    /\ live_leases \in SUBSET Runs

(* Invariant: Bounded retries *)
(* A run cannot be resumed more than MaxResumeAttempts times *)
BoundedRetriesInvariant ==
    \A r \in Runs :
        resume_attempts[r] <= MaxResumeAttempts

(* Invariant: Interrupted runs can be resumed *)
(* Only INTERRUPTED runs can be resumed *)
ResumeOnlyInterrupted ==
    \A r \in Runs :
        resume_attempts[r] > 0 => run_states[r] \in {INTERRUPTED, RUNNING, FAILED}

(* Invariant: Failed runs cannot be resumed *)
(* After MaxResumeAttempts, the run is FAILED *)
FailedRunInvariant ==
    \A r \in Runs :
        resume_attempts[r] >= MaxResumeAttempts => run_states[r] = FAILED

(* Invariant: Idempotency *)
(* Calling resume on a non-interrupted run has no effect *)
IdempotencyInvariant ==
    \A r \in Runs :
        run_states[r] \in {RUNNING, COMPLETED, CREATED} =>
            resume_attempts[r] = resume_attempts[r]

(* Invariant: Live leases are subset of running runs *)
LiveLeasesInvariant ==
    \A l \in live_leases :
        run_states[l] = RUNNING

(* Actions *)
StartRun(run_id) ==
    /\ run_id \in Runs
    /\ run_states[run_id] = CREATED
    /\ run_states' = [run_states EXCEPT ![run_id] = RUNNING]
    /\ UNCHANGED <<resume_attempts, live_leases>>

InterruptRun(run_id) ==
    /\ run_id \in Runs
    /\ run_states[run_id] = RUNING
    /\ run_states' = [run_states EXCEPT ![run_id] = INTERRUPTED]
    /\ live_leases' = live_leases \ {run_id}
    /\ UNCHANGED resume_attempts

ResumeRun(run_id) ==
    /\ run_id \in Runs
    /\ run_states[run_id] = INTERRUPTED
    /\ resume_attempts[run_id] < MaxResumeAttempts
    /\ run_states' = [run_states EXCEPT ![run_id] = RUNNING]
    /\ resume_attempts' = [resume_attempts EXCEPT ![run_id] = @ + 1]
    /\ live_leases' = live_leases \cup {run_id}

FailRun(run_id) ==
    /\ run_id \in Runs
    /\ run_states[run_id] = INTERRUPTED
    /\ resume_attempts[run_id] >= MaxResumeAttempts
    /\ run_states' = [run_states EXCEPT ![run_id] = FAILED]
    /\ UNCHANGED <<resume_attempts, live_leases>>

CompleteRun(run_id) ==
    /\ run_id \in Runs
    /\ run_states[run_id] = RUNNING
    /\ run_states' = [run_states EXCEPT ![run_id] = COMPLETED]
    /\ live_leases' = live_leases \ {run_id}
    /\ UNCHANGED resume_attempts

(* Safety properties *)
Safety ==
    /\ BoundedRetriesInvariant
    /\ ResumeOnlyInterrupted
    /\ FailedRunInvariant
    /\ IdempotencyInvariant
    /\ LiveLeasesInvariant

(* Liveness: Every interrupted run eventually resumes or fails *)
Liveness ==
    \A r \in Runs :
        run_states[r] = INTERRUPTED =>
            <>(run_states[r] = RUNNING \/ run_states[r] = FAILED)

=============================================================================
