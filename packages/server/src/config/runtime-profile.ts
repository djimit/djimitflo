export type RuntimeProfile = 'api' | 'operator' | 'autonomous';

const VALID_RUNTIME_PROFILES = new Set<RuntimeProfile>(['api', 'operator', 'autonomous']);

export function resolveRuntimeProfile(env: NodeJS.ProcessEnv = process.env): RuntimeProfile {
  const raw = env.DJIMITFLO_RUNTIME_PROFILE?.trim().toLowerCase();
  if (!raw) return 'api';
  if (VALID_RUNTIME_PROFILES.has(raw as RuntimeProfile)) return raw as RuntimeProfile;
  console.warn(`⚠️  Invalid DJIMITFLO_RUNTIME_PROFILE="${raw}", using api`);
  return 'api';
}

export function runtimeProfileEnablesOperator(profile: RuntimeProfile): boolean {
  return profile === 'operator' || profile === 'autonomous';
}

export function runtimeProfileEnablesAutonomy(profile: RuntimeProfile): boolean {
  return profile === 'autonomous';
}
