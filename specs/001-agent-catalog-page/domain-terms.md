# Domain Terms — Agent Catalog Bounded Context

> Ubiquitous Language for the Agent Catalog BC.
> Every term below has exactly one meaning within this BC.

---

## Term: Agent

**Definition:**
An autonomous worker entity that has been imported into the system and can be evaluated, activated, and assigned to tasks.

**Business Context:**
Agents are imported from external sources, then evaluated for compliance and quality. States: Imported → Evaluated → Active | Inactive.

**Invariants (EARS):**
- THE Agent SHALL have a unique name within the catalog
- WHEN an Agent is deactivated THEN it SHALL NOT be assigned new tasks

**Related Terms:**
Catalog, Division, Evaluation

**Aliases to AVOID:**
Worker, Node, Bot, Runner, Instance, Process, Service

---

## Term: Catalog

**Definition:**
The collection of all imported agents, accessible through the dashboard UI and API.

**Business Context:**
The Catalog is the primary view for agent management. It supports filtering, searching, and activation/deactivation.

**Invariants (EARS):**
- THE Catalog SHALL display all imported agents
- WHEN the Catalog is empty THEN show "No agents imported yet"

**Related Terms:**
Agent, Division

**Aliases to AVOID:**
AgentList, AgentCollection, Registry, Directory

---

## Term: Division

**Definition:**
A logical grouping of agents by organizational unit or functional area.

**Business Context:**
Divisions allow operators to filter agents by team or purpose. Divisions are assigned at import time.

**Invariants (EARS):**
- THE Division SHALL be a non-empty string
- WHEN filtering by Division THEN only agents in that division SHALL be shown

**Related Terms:**
Agent, Catalog

**Aliases to AVOID:**
Team, Group, Category, Department

---

## Term: Evaluation

**Definition:**
The process of scoring an agent against compliance and quality criteria.

**Business Context:**
Evaluations produce a numerical score and status. An agent must be evaluated before activation.

**Invariants (EARS):**
- THE Evaluation SHALL produce a score between 0 and 100
- WHEN an Agent is evaluated THEN its status SHALL update to Evaluated

**Related Terms:**
Agent

**Aliases to AVOID:**
Assessment, Review, Scoring, Rating

---

**Version**: 1.0.0 | **BC**: Agent Catalog
