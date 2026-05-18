/**
 * Repository-related types
 */

import { ID, Timestamps } from './common';
import type { RepositoryProvider, RepositoryStatus } from './repository-intelligence';

export interface Repository extends Timestamps {
  id: ID;
  name: string;
  description: string;
  path: string;
  
  // Git info
  git_remote: string | null;
  git_branch: string | null;
  git_commit: string | null;
  
  // State
  is_active: boolean;
  last_synced_at: string | null;
  
  // Phase 4.4: Repository Intelligence
  provider: RepositoryProvider;
  status: RepositoryStatus;
  detected_stacks: string[];
  package_manager: string;
  test_commands: string[];
  build_commands: string[];
  lint_commands: string[];
  typecheck_commands: string[];
  has_git: boolean;
  has_agents_md: boolean;
  health_score: number | null;
  
  metadata: Record<string, unknown>;
}

export interface RepositoryCreateInput {
  name: string;
  description: string;
  path: string;
  git_remote?: string;
  git_branch?: string;
  metadata?: Record<string, unknown>;
}

export interface RepositoryUpdateInput {
  name?: string;
  description?: string;
  path?: string;
  git_remote?: string;
  git_branch?: string;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
}
