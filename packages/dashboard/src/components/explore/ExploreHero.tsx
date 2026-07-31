import type { ExploreHeroProps } from '@djimitflo/shared';

export function ExploreHero({
  repository_full_name,
  repository_url,
  tagline,
  stack_badges,
  openmythos_score,
  health_score,
  generated_at,
}: ExploreHeroProps) {
  const trust = openmythos_score ?? 0;
  const trustLabel = trust >= 85 ? 'Verified' : trust >= 60 ? 'Review' : 'Early';
  const trustColor = trust >= 85 ? 'text-emerald-400' : trust >= 60 ? 'text-amber-400' : 'text-rose-500';

  return (
    <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-8 md:p-12">
      <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl" />
      <div className="relative z-10">
        <p className="mb-2 text-sm font-medium tracking-wider text-indigo-400 uppercase">Djimit Explore</p>
        <h1 className="text-3xl font-bold text-slate-100 md:text-5xl">{repository_full_name}</h1>
        <p className="mt-3 max-w-2xl text-lg text-slate-400">{tagline}</p>

        <div className="mt-6 flex flex-wrap gap-3">
          {stack_badges.map((badge) => (
            <div
              key={badge.name}
              className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/50 px-3 py-1.5 text-sm text-slate-200"
              title={`Detected from ${badge.detected_from}`}
            >
              <span>{badge.icon ?? '●'}</span>
              <span>{badge.name}</span>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-6">
          <div
            className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-3"
            title={`OpenMythos trust score: ${trust.toFixed(1)} / 100`}
          >
            <div className={`text-2xl font-bold ${trustColor}`}>{trust.toFixed(0)}</div>
            <div className="text-xs text-slate-400">
              <div className="font-medium text-slate-200">{trustLabel}</div>
              <div>OpenMythos</div>
            </div>
          </div>

          {health_score !== null && (
            <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-3">
              <svg viewBox="0 0 36 36" className="h-10 w-10 -rotate-90">
                <path className="fill-none stroke-slate-700" strokeWidth="4" d="M18 2a16 16 0 1 1 0 32 16 16 0 1 1 0-32" />
                <path
                  className="fill-none stroke-indigo-500"
                  strokeWidth="4"
                  strokeDasharray={`${health_score}, 100`}
                  d="M18 2a16 16 0 1 1 0 32 16 16 0 1 1 0-32"
                />
              </svg>
              <div className="text-xs text-slate-400">
                <div className="font-medium text-slate-200">{health_score}/100</div>
                <div>Health</div>
              </div>
            </div>
          )}

          <a
            href={repository_url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl bg-indigo-500 px-5 py-3 text-sm font-medium text-white transition hover:bg-indigo-400"
          >
            View on GitHub
          </a>
        </div>

        <p className="mt-6 text-xs text-slate-500">Last generated: {new Date(generated_at).toLocaleString()}</p>
      </div>
    </section>
  );
}
