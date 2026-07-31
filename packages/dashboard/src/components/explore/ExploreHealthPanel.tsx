import type { ExploreHealthPanelProps, HealthMeter } from '@djimitflo/shared';

function meterStatusClass(status: HealthMeter['status']) {
  switch (status) {
    case 'good':
      return 'bg-emerald-500';
    case 'warning':
      return 'bg-amber-400';
    case 'critical':
      return 'bg-rose-500';
    default:
      return 'bg-slate-500';
  }
}

export function ExploreHealthPanel({ overall_health, meters }: ExploreHealthPanelProps) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 md:p-8">
      <h2 className="text-xl font-semibold text-slate-100">Repository health</h2>
      {overall_health !== null && (
        <div className="mt-4 flex items-center gap-4">
          <div className="text-3xl font-bold text-slate-100">{overall_health}</div>
          <div className="text-sm text-slate-400">Overall health score out of 100</div>
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {meters.map((meter) => (
          <div
            key={meter.label}
            className="rounded-xl border border-slate-700 bg-slate-800/40 p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-300">{meter.label}</span>
              <span
                className={`inline-block h-2 w-2 rounded-full ${meterStatusClass(meter.status)}`}
                aria-hidden="true"
              />
            </div>
            <div className="mt-2 text-lg font-semibold text-slate-100">{meter.score}/100</div>
            {meter.recommendation && (
              <p className="mt-1 text-xs text-slate-400">{meter.recommendation}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
