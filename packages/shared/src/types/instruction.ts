/**
 * Instruction profile types (AGENTS.md management)
 */

import { ID, Timestamps } from './common';

export interface InstructionProfile extends Timestamps {
  id: ID;
  name: string;
  description: string;
  
  // Content
  agents_md_content: string;
  
  // Validation
  is_valid: boolean;
  validation_errors: string[];
  last_validated_at: string | null;
  
  // Usage
  active_tasks: number;
  total_tasks: number;
  
  metadata: Record<string, unknown>;
}

export interface InstructionProfileCreateInput {
  name: string;
  description: string;
  agents_md_content: string;
  metadata?: Record<string, unknown>;
}

export interface InstructionProfileUpdateInput {
  name?: string;
  description?: string;
  agents_md_content?: string;
  metadata?: Record<string, unknown>;
}

export interface InstructionValidationResult {
  is_valid: boolean;
  errors: InstructionValidationError[];
  warnings: InstructionValidationWarning[];
}

export interface InstructionValidationError {
  line: number | null;
  message: string;
  severity: 'error';
}

export interface InstructionValidationWarning {
  line: number | null;
  message: string;
  severity: 'warning';
}
