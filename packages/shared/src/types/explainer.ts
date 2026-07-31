
/**
 * Explainer-related types for the explain_repo loop.
 */

import { ID, Timestamps } from './common';

export enum ExplainerProvider {
  LOCAL = 'local',
  GITHUB = 'github',
  GITLAB = 'gitlab',
}

export enum ExplainerStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum ExplainerBundleStatus {
  PENDING = 'pending',
  PUBLISHED = 'published',
  HUMAN_REVIEW = 'human_review',
  UNPUBLISHED = 'unpublished',
}

export enum ExplainerJobStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum RepoCategory {
  PLATFORM = 'platform',
  PLUGIN = 'plugin',
  TOOL = 'tool',
  EXPERIMENTAL = 'experimental',
  OTHER = 'other',
}

export interface ExplainerTask extends Timestamps {
  id: ID;
  title: string;
  description: string;
  provider: ExplainerProvider;
  remote_url: string | null;
  local_path: string | null;
  branch: string | null;
  repository_id: string | null;
  error_message: string | null;
  scan_id: string | null;
  status: ExplainerStatus;
  metadata: Record<string, unknown>;
}

export interface ExplainerBundle extends Timestamps {
  id: ID;
  task_id: ID;
  bundle_path: string;
  manifest_path: string | null;
  markdown_path: string | null;
  llms_txt_path: string | null;
  facts_path: string | null;
  sections_path: string | null;
  assets_path: string | null;
  status: ExplainerBundleStatus;
  content_hash: string | null;
  openmythos_score: number | null;
  openmythos_rationale: string | null;
  token_count: number | null;
  metadata: Record<string, unknown>;
}

export interface ExplainerCreateInput {
  title: string;
  description?: string;
  provider?: ExplainerProvider;
  remote_url?: string;
  local_path?: string;
  branch?: string;
  metadata?: Record<string, unknown>;
}

export interface ExplainerRunInput {
  task_id: ID;
  options?: {
    skip_graph?: boolean;
    skip_eval?: boolean;
    dry_run?: boolean;
  };
}

export interface DiscoveredRepository extends Timestamps {
  id: ID;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  last_commit_sha: string | null;
  last_commit_at: string | null;
  repo_category: RepoCategory;
  language: string | null;
  license: string | null;
  stargazers_count: number;
  open_issues_count: number;
  priority_tier: 1 | 2 | 3;
  html_url: string;
  clone_url: string;
  is_active: boolean;
  last_discovered_at: string;
  metadata: Record<string, unknown>;
}

export interface ExplainerJob extends Timestamps {
  id: ID;
  task_id: ID;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  worker_id: string | null;
  retry_count: number;
  status: ExplainerJobStatus;
  priority_score: number;
  scheduled_reason: string;
  metadata: Record<string, unknown>;
}

export interface RepoGraphSnapshot extends Timestamps {
  id: ID;
  repository_id: ID;
  scan_id: ID | null;
  commit_sha: string | null;
  communities: unknown[];
  flows: unknown[];
  hub_nodes: unknown[];
  bridge_nodes: unknown[];
  surprising_connections: unknown[];
  metrics: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface ExplainerFeedback extends Timestamps {
  id: ID;
  bundle_id: ID;
  section_type: string | null;
  fact_id: string | null;
  correction: string;
  submitted_by: string | null;
  reviewed: boolean;
  review_decision: 'accepted' | 'rejected' | 'pending' | null;
  metadata: Record<string, unknown>;
}

export interface HumanReviewQueueItem extends Timestamps {
  id: ID;
  bundle_id: ID;
  reason: string;
  openmythos_score: number | null;
  assigned_to: string | null;
  resolved: boolean;
  resolution: 'approved' | 'rejected' | 'pending' | null;
  resolved_at: string | null;
  metadata: Record<string, unknown>;
}

export interface ExplainerAuditLogEntry {
  id: ID;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  outcome: 'success' | 'failure' | 'blocked' | 'pending';
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface GraphSummary {
  total_nodes: number;
  total_edges: number;
  total_files: number;
  risk_score: number | null;
  communities: Array<{ name: string; size: number; cohesion: number; language: string }>;
  top_flows: Array<{ name: string; criticality: number; depth: number; node_count: number }>;
  hub_nodes: Array<{ name: string; file: string; total_degree: number }>;
  bridge_nodes: Array<{ name: string; file: string; betweenness: number }>;
}

export interface OpenMythosScores {
  hallucination: number;
  calibration: number;
  tool_scope: number;
  contradiction: number;
  overthinking: number;
}

export interface ExplainerManifest {
  schema_version: string;
  bundle_id: ID;
  task_id: ID;
  repository_full_name: string;
  repository_url: string;
  source_commit: string;
  pipeline_version: string;
  generated_at: string;
  openmythos_score: number | null;
  content_hash: string;
  sections: Array<{ type: string; title: string; file: string; citations: string[] }>;
  assets: string[];
}

export interface ExplainerFact {
  id: string;
  claim: string;
  source_ref: string;
  source_type: 'file_line' | 'graph_node' | 'readme_heading' | 'scan_finding';
  file_path?: string;
  line_start?: number;
  line_end?: number;
  confidence: number;
}

export interface ExplainerBundleContent {
  manifest: ExplainerManifest;
  explainer_md: string;
  llms_txt: string;
  facts: ExplainerFact[];
  sections: Record<string, string>;
  metadata: {
    task_id: ID;
    repository_url: string | null;
    local_path: string | null;
    generated_at: string;
  };
  graph_summary: GraphSummary;
  openmythos_scores: OpenMythosScores | null;
}

export interface ExplainerCorpusCase {
  id: string;
  category: 'factuality' | 'hallucination' | 'quality' | 'security' | 'license' | 'coverage';
  subcategory: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  prompt: string;
  expected_behavior: string;
  failure_mode: string;
  rationale: string;
  oracle_type?: 'contains' | 'equals' | 'regex' | 'json_path';
  oracle_rule?: Record<string, unknown>;
}

export interface ExplainerCriticDimension {
  name: 'factuality' | 'hallucination' | 'quality' | 'security' | 'license' | 'coverage';
  score: number;
  rationale: string;
  findings: string[];
}

export interface ExplainerCriticResult {
  overall_score: number;
  threshold: number;
  passed: boolean;
  dimensions: ExplainerCriticDimension[];
  retry_hints: string[];
  latency_ms: number;
}

export interface StackBadge {
  name: string;
  icon?: string;
  detected_from: string;
}

export interface HealthMeter {
  label: string;
  score: number;
  status: 'good' | 'warning' | 'critical' | 'unknown';
  recommendation?: string;
}

export interface ExploreHeroProps {
  repository_full_name: string;
  repository_url: string;
  tagline: string;
  stack_badges: StackBadge[];
  openmythos_score: number | null;
  health_score: number | null;
  generated_at: string;
}

export interface ExploreArchitectureNode {
  id: string;
  label: string;
  file?: string;
  community?: string;
  kind: 'hub' | 'bridge' | 'normal';
}

export interface ExploreArchitectureEdge {
  from: string;
  to: string;
  label?: string;
  surprising?: boolean;
}

export interface ExploreArchitectureDiagramProps {
  nodes: ExploreArchitectureNode[];
  edges: ExploreArchitectureEdge[];
}

export interface ExploreHealthPanelProps {
  overall_health: number | null;
  meters: HealthMeter[];
}

export interface ExploreReadmeWidgetProps {
  repository_full_name: string;
  openmythos_score: number | null;
  tagline: string;
  explainer_url: string;
}
