---------------------------- MODULE RBAC ----------------------------
(*
 * TLA+ Specification for Role-Based Access Control
 *
 * Invariant: No privilege escalation.
 * Property: A role cannot grant permissions it doesn't have.
 *)

EXTENDS Naturals, FiniteSets

CONSTANTS
    Roles,          (* Set of all roles *)
    Permissions,    (* Set of all permissions *)
    Users,          (* Set of all users *)
    Resources       (* Set of all resources *)

VARIABLES
    user_roles,     (* [user -> SUBSET Roles] *)
    role_permissions, (* [role -> SUBSET Permissions] *)
    resource_classification, (* [resource -> Classification] *)
    access_log      (* sequence of access attempts *)

TypeInvariant ==
    /\ user_roles \in [Users -> SUBSET Roles]
    /\ role_permissions \in [Roles -> SUBSET Permissions]
    /\ resource_classification \in [Resources -> {"public", "internal", "confidential", "restricted"}]
    /\ access_log \in Seq([user: Users, resource: Resources, granted: BOOLEAN])

(* Role hierarchy *)
RoleHierarchy ==
    [admin |-> {admin, platform_admin, approver, maker, checker, auditor, viewer},
     platform_admin |-> {platform_admin, viewer},
     approver |-> {approver, viewer},
     maker |-> {maker, viewer},
     checker |-> {checker, viewer},
     auditor |-> {auditor, viewer},
     viewer |-> {viewer}]

(* Invariant: No privilege escalation *)
(* A user cannot access resources above their role's classification *)
NoPrivilegeEscalation ==
    \A u \in Users :
        \A r \in Resources :
            CanAccess(u, r) =>
                RequiredClassification(r) <= MaxClassification(u)

(* Invariant: Separation of duties *)
(* Maker cannot approve their own tasks *)
SeparationOfDuties ==
    \A u \in Users :
        "maker" \in user_roles[u] => "approver" \notin user_roles[u]

(* Invariant: Admin has all permissions *)
AdminHasAllPermissions ==
    \A p \in Permissions :
        p \in role_permissions[admin]

(* Invariant: Viewer has only read permissions *)
ViewerReadOnly ==
    \A p \in role_permissions[viewer] :
        p \in {"read:evidence", "read:repository"}

(* Helper operators *)
CanAccess(user, resource) ==
    \E role \in user_roles[user] :
        \E perm \in role_permissions[role] :
            PermissionCovers(perm, resource)

PermissionCovers(permission, resource) ==
    /\ permission \in {"read:evidence", "read:repository", "scan:repository"}
    /\ resource_classification[resource] \in {"public", "internal"}

RequiredClassification(resource) ==
    resource_classification[resource]

MaxClassification(user) ==
    CHOOSE role \in user_roles[user] :
        ClassificationRank(role) = Max({ClassificationRank(r) : r \in user_roles[user]})

ClassificationRank(role) ==
    CASE role OF
        "admin" -> 4
        "platform_admin" -> 3
        "approver" -> 2
        "maker" -> 2
        "checker" -> 2
        "auditor" -> 1
        "viewer" -> 0
        OTHER -> 0

(* Actions *)
AssignRole(user, role) ==
    /\ user \in Users
    /\ role \in Roles
    /\ user_roles' = [user_roles EXCEPT ![user] = @ \cup {role}]
    /\ UNCHANGED <<role_permissions, resource_classification, access_log>>

RevokeRole(user, role) ==
    /\ user \in Users
    /\ role \in Roles
    /\ user_roles' = [user_roles EXCEPT ![user] = @ \setminus {role}]
    /\ UNCHANGED <<role_permissions, resource_classification, access_log>>

AttemptAccess(user, resource) ==
    /\ user \in Users
    /\ resource \in Resources
    /\ LET granted == CanAccess(user, resource)
       IN access_log' = Append(access_log, [user |-> user, resource |-> resource, granted |-> granted])
    /\ UNCHANGED <<user_roles, role_permissions, resource_classification>>

(* Safety properties *)
Safety ==
    /\ NoPrivilegeEscalation
    /\ SeparationOfDuties
    /\ AdminHasAllPermissions
    /\ ViewerReadOnly

(* Liveness: Every access attempt is logged *)
Liveness ==
    \A u \in Users :
        \A r \in Resources :
            <>(\E a \in access_log :
                a.user = u /\ a.resource = r)

=============================================================================
