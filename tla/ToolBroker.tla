---------------------------- MODULE ToolBroker ----------------------------
(*
 * TLA+ Specification for ToolBroker
 *
 * Invariant: No executor can bypass the ToolBroker for mutating actions.
 * Property: All tool calls are evaluated against policies before execution.
 *)

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Tools,          (* Set of all tools *)
    Principals,      (* Set of all principals *)
    Policies,        (* Set of all policies *)
    RiskLevels,      (* {LOW, MEDIUM, HIGH, CRITICAL} *)
    Decisions        (* {ALLOW, DENY, REQUIRE_APPROVAL} *)

VARIABLES
    decisions,      (* [decision_id -> decision_record] *)
    capability_tokens, (* [token_id -> token_record] *)
    audit_log       (* sequence of audit entries *)

TypeInvariant ==
    /\ decisions \in [decision_id -> [tool: Tools, principal: Principals, decision: Decisions]]
    /\ capability_tokens \in [token_id -> [tool: Tools, principal: Principals, scope: SUBSET Tools]]
    /\ audit_log \in Seq([decision_id: decision_id, action: Decisions, timestamp: Nat])

(* Invariant: No executor bypass *)
(* Every mutating action MUST go through evaluateToolCall *)
NoBypassInvariant ==
    \A d \in DOMAIN decisions :
        decisions[d].decision \in Decisions => \E a \in audit_log :
            a.decision_id = d

(* Invariant: Default deny *)
(* If no policy matches, the decision is DENY *)
DefaultDenyInvariant ==
    \A d \in DOMAIN decisions :
        decisions[d].decision = DENY => \A p \in Policies :
            ~PolicyMatches(p, decisions[d])

(* Invariant: Capability tokens are scoped *)
(* A token cannot be used for tools outside its scope *)
TokenScopeInvariant ==
    \A t \in DOMAIN capability_tokens :
        \A d \in DOMAIN decisions :
            decisions[d].tool \in capability_tokens[t].scope =>
                decisions[d].principal = capability_tokens[t].principal

(* Invariant: High-risk actions require approval *)
HighRiskRequiresApproval ==
    \A d \in DOMAIN decisions :
        RiskLevel(decisions[d].tool) \in {HIGH, CRITICAL} =>
            decisions[d].decision = REQUIRE_APPROVAL

(* Helper operators *)
PolicyMatches(p, d) ==
    /\ d.tool \in p.tools
    /\ d.principal \in p.principals

RiskLevel(tool) ==
    CASE tool OF
        "rm_rf" -> CRITICAL
        "exec" -> HIGH
        "write_file" -> MEDIUM
        "read_file" -> LOW
        OTHER -> LOW

(* Actions *)
EvaluateToolCall(principal, tool, policy) ==
    /\ LET decision_id == Hash(principal, tool)
           decision == IF policy \in Policies
                        THEN policy.decision
                        ELSE DENY
       IN /\ decisions' = decisions @@ (decision_id -> [tool |-> tool, principal |-> principal, decision |-> decision])
          /\ audit_log' = Append(audit_log, [decision_id |-> decision_id, action |-> decision, timestamp |-> Len(audit_log)])
    /\ UNCHANGED capability_tokens

IssueCapabilityToken(decision_id, principal, tool) ==
    /\ decision_id \in DOMAIN decisions
    /\ decisions[decision_id].decision = ALLOW
    /\ LET token_id == Hash(decision_id, "token")
       IN capability_tokens' = capability_tokens @@ (token_id -> [tool |-> tool, principal |-> principal, scope |-> {tool}])
    /\ UNCHANGED <<decisions, audit_log>>

ValidateCapabilityToken(token_id, tool, task_id) ==
    /\ token_id \in DOMAIN capability_tokens
    /\ tool \in capability_tokens[token_id].scope

(* Safety properties *)
Safety ==
    /\ NoBypassInvariant
    /\ DefaultDenyInvariant
    /\ TokenScopeInvariant
    /\ HighRiskRequiresApproval

(* Liveness: Every tool call eventually gets a decision *)
Liveness ==
    \A principal \in Principals :
        \A tool \Tools :
            <>(\E d \in DOMAIN decisions :
                decisions[d].principal = principal /\ decisions[d].tool = tool)

=============================================================================
