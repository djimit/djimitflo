/**
 * Repository-related types
 */

import { ID, Timestamps } from './common';

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
