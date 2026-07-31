import type { ExploreReadmeWidgetProps } from '@djimitflo/shared';

export function ExploreReadmeWidget({
  repository_full_name,
  openmythos_score,
  tagline,
  explainer_url,
}: ExploreReadmeWidgetProps) {
  const score = openmythos_score ?? 0;
  const color = score >= 85 ? '34d399' : score >= 60 ? 'fbbf24' : 'f43f5e';
  const badgeUrl = `https://img.shields.io/badge/Explore-${Math.round(score)}%2F100-${color}?logo=github\u0026style=flat`;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 md:p-8">
      <h2 className="text-xl font-semibold text-slate-100">README embed widget</h2>
      <p className="mt-1 text-sm text-slate-400">Copy this snippet into {repository_full_name}’s README to link visitors to the explainer page.</p>

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-700 bg-slate-950 p-4">
        <pre className="text-xs text-slate-300">
{`[![Djimit Explore](${badgeUrl})](${explainer_url})

> ${tagline}
>
> [Read the full Djimit Explore page →](${explainer_url})`}
        </pre>
      </div>

      <div className="mt-4">
        <a href={explainer_url} target="_blank" rel="noopener noreferrer">
          <img src={badgeUrl} alt={`Djimit Explore score ${Math.round(score)} / 100`} />
        </a>
      </div>
    </section>
  );
}
