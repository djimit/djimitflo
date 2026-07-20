/**
 * Environment variable validation with fail-fast on missing required vars.
 *
 * Pattern: 12-Factor App — strict config validation at startup.
 * Uses native TypeScript types (no Zod dependency to keep bundle small).
 */

export interface EnvConfig {
  PORT: number;
  HOST: string;
  NODE_ENV: 'development' | 'production' | 'test';
  JWT_SECRET: string;
  DB_PATH: string;
  CORS_ORIGINS: string[];
  OPENMYTHOS_CORPUS_PATH: string;
  OPENMYTHOS_JUDGE_MODEL: string;
  OPENMYTHOS_AGENT_MODEL: string;
  OLLAMA_URL: string;
  LITELLM_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  GOOGLE_API_KEY: string;
  SEGML_FAILURE_THRESHOLD: number;
  SEGML_MIN_CASES_FOR_PATTERN: number;
  SEGML_MAX_GENERATED_CASES: number;
  SEGML_CONSOLIDATION_CONFIDENCE: number;
  SEGML_JUDGE_UPDATE_MIN_EVIDENCE: number;
  SEGML_VALIDATION_ENABLED: boolean;
  SEGML_ROLLBACK_ENABLED: boolean;
  SEGML_AUTO_APPROVE_CASES: boolean;
  SEGML_CYCLE_INTERVAL_MS: number;
<<<<<<< HEAD
=======
  SEGML_MAX_CORPUS_SIZE: number;
>>>>>>> feat/segml-self-evolving-governance
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (value === undefined) {
    return '';
  }
  return value;
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    console.warn(`⚠️  Invalid integer for ${key}: "${value}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function getEnvList(key: string, defaultValue: string[]): string[] {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

const requiredEnvVars = ['JWT_SECRET'];

export function validateEnv(): void {
  const missing: string[] = [];

  for (const key of requiredEnvVars) {
    if (!process.env[key] && key !== 'JWT_SECRET') {
      missing.push(key);
    }
  }

  // JWT_SECRET has a fallback for development but warn
  if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
    missing.push('JWT_SECRET (required in production)');
  }

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    for (const key of missing) {
      console.error(`   - ${key}`);
    }
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}

export const config: EnvConfig = {
  PORT: getEnvInt('PORT', 3001),
  HOST: getEnv('HOST', '0.0.0.0'),
  NODE_ENV: (getEnv('NODE_ENV', 'development') as EnvConfig['NODE_ENV']),
  JWT_SECRET: getEnv('JWT_SECRET', 'dev-secret-change-in-production'),
  DB_PATH: getEnv('DB_PATH', ''),
  CORS_ORIGINS: getEnvList('CORS_ORIGINS', ['http://localhost:5173', 'http://127.0.0.1:5173']),
  OPENMYTHOS_CORPUS_PATH: getEnv('OPENMYTHOS_CORPUS_PATH', ''),
  OPENMYTHOS_JUDGE_MODEL: getEnv('OPENMYTHOS_JUDGE_MODEL', 'qwen2.5:14b-instruct-q4_K_M'),
  OPENMYTHOS_AGENT_MODEL: getEnv('OPENMYTHOS_AGENT_MODEL', ''),
  OLLAMA_URL: getEnv('OLLAMA_URL', 'http://192.168.1.28:11434'),
  LITELLM_API_KEY: getEnv('LITELLM_API_KEY', ''),
  ANTHROPIC_API_KEY: getEnv('ANTHROPIC_API_KEY', ''),
  OPENAI_API_KEY: getEnv('OPENAI_API_KEY', ''),
  GOOGLE_API_KEY: getEnv('GOOGLE_API_KEY', ''),
  SEGML_FAILURE_THRESHOLD: getEnvInt('SEGML_FAILURE_THRESHOLD', 25) / 10,
  SEGML_MIN_CASES_FOR_PATTERN: getEnvInt('SEGML_MIN_CASES_FOR_PATTERN', 3),
  SEGML_MAX_GENERATED_CASES: getEnvInt('SEGML_MAX_GENERATED_CASES', 20),
  SEGML_CONSOLIDATION_CONFIDENCE: getEnvInt('SEGML_CONSOLIDATION_CONFIDENCE', 6) / 10,
  SEGML_JUDGE_UPDATE_MIN_EVIDENCE: getEnvInt('SEGML_JUDGE_UPDATE_MIN_EVIDENCE', 5),
  SEGML_VALIDATION_ENABLED: getEnv('SEGML_VALIDATION_ENABLED', 'true') !== 'false',
  SEGML_ROLLBACK_ENABLED: getEnv('SEGML_ROLLBACK_ENABLED', 'true') !== 'false',
  SEGML_AUTO_APPROVE_CASES: getEnv('SEGML_AUTO_APPROVE_CASES', 'true') !== 'false',
  SEGML_CYCLE_INTERVAL_MS: getEnvInt('SEGML_CYCLE_INTERVAL_MS', 3600000),
<<<<<<< HEAD
=======
  SEGML_MAX_CORPUS_SIZE: getEnvInt('SEGML_MAX_CORPUS_SIZE', 1000),
>>>>>>> feat/segml-self-evolving-governance
};
