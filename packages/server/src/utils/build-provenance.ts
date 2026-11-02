/**
 * Build provenance from the image itself (Dockerfile build args → DJIMITFLO_BUILD_*), independent of the runtime
 * environment. DJIMITFLO_COMMIT_SHA comes from compose/runtime.env and can drift or be duplicated across files; the
 * baked build commit reflects what was actually built into the running artifact. Shared by /health, /api/health and
 * /api/health/config so all three report the same identity.
 */
export interface BuildProvenance {
  commit: string | null;
  built_commit: string | null;
  build_source: string | null;
  build_time: string | null;
  instance_id: string | null;
  commit_matches_build: boolean;
}

export function buildProvenance(env: NodeJS.ProcessEnv = process.env): BuildProvenance {
  const runtimeCommit = env.DJIMITFLO_COMMIT_SHA || null;
  const builtCommit = env.DJIMITFLO_BUILD_COMMIT && env.DJIMITFLO_BUILD_COMMIT !== 'unknown' ? env.DJIMITFLO_BUILD_COMMIT : null;
  return {
    commit: runtimeCommit,
    built_commit: builtCommit,
    build_source: env.DJIMITFLO_BUILD_SOURCE || null,
    build_time: env.DJIMITFLO_BUILD_TIME || null,
    instance_id: env.DJIMITFLO_INSTANCE_ID || null,
    // A deployed artifact is only attributable when the running revision and the baked build revision agree.
    commit_matches_build: !!(runtimeCommit && builtCommit && runtimeCommit === builtCommit),
  };
}
