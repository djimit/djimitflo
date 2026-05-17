import type { ExecutionEvent } from '@djimitflo/shared';
import { Activity, CheckCircle2, XCircle, AlertTriangle, Info, Terminal, FileText } from 'lucide-react';

interface ExecutionTimelineProps {
  events: ExecutionEvent[];
}

export function ExecutionTimeline({ events }: ExecutionTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-8 text-foreground-muted">
        No execution events yet
      </div>
    );
  }

  // Sort events by timestamp (newest first)
  const sortedEvents = [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return (
    <div className="space-y-4">
      {sortedEvents.map((event, index) => (
        <TimelineItem
          key={event.id}
          event={event}
          isLast={index === sortedEvents.length - 1}
        />
      ))}
    </div>
  );
}

interface TimelineItemProps {
  event: ExecutionEvent;
  isLast: boolean;
}

function TimelineItem({ event, isLast }: TimelineItemProps) {
  const config = getEventConfig(event.event_type, event.level);

  return (
    <div className="flex gap-4">
      {/* Timeline Indicator */}
      <div className="flex flex-col items-center">
        <div className={`p-2 rounded-full ${config.bgColor}`}>
          {config.icon}
        </div>
        {!isLast && (
          <div className="w-0.5 flex-1 bg-border mt-2" style={{ minHeight: '40px' }} />
        )}
      </div>

      {/* Event Content */}
      <div className="flex-1 pb-6">
        <div className="bg-background-elevated border border-border rounded-lg p-4">
          {/* Header */}
          <div className="flex items-start justify-between mb-2">
            <div>
              <div className="flex items-center gap-2">
                <span className={`text-sm font-semibold ${config.textColor}`}>
                  {formatEventType(event.event_type)}
                </span>
                <span className={`px-2 py-0.5 text-xs font-medium rounded ${config.levelColor}`}>
                  {event.level}
                </span>
              </div>
              <p className="text-sm text-foreground mt-1">{event.message}</p>
            </div>
            <span className="text-xs text-foreground-muted whitespace-nowrap">
              {formatTimestamp(event.timestamp)}
            </span>
          </div>

          {/* Tool Call Details */}
          {event.tool_name && (
            <div className="mt-3 pt-3 border-t border-border">
              <div className="flex items-center gap-2 mb-2">
                <Terminal className="w-4 h-4 text-foreground-tertiary" />
                <span className="text-sm font-medium text-foreground">
                  Tool: <code className="px-1.5 py-0.5 bg-background rounded text-accent">{event.tool_name}</code>
                </span>
              </div>

              {event.tool_input && (
                <details className="mt-2">
                  <summary className="text-xs text-foreground-secondary cursor-pointer hover:text-foreground">
                    View Input
                  </summary>
                  <pre className="mt-2 p-2 bg-background rounded text-xs text-foreground-secondary overflow-x-auto">
                    {JSON.stringify(event.tool_input, null, 2)}
                  </pre>
                </details>
              )}

              {event.tool_output ? (
                <details className="mt-2">
                  <summary className="text-xs text-foreground-secondary cursor-pointer hover:text-foreground">
                    View Output
                  </summary>
                  <pre className="mt-2 p-2 bg-background rounded text-xs text-foreground-secondary overflow-x-auto">
                    {typeof event.tool_output === 'string'
                      ? event.tool_output as string
                      : JSON.stringify(event.tool_output, null, 2)}
                  </pre>
                </details>
              ) : null}

              {event.tool_error && (
                <div className="mt-2 p-2 bg-status-error/10 border border-status-error/20 rounded">
                  <div className="flex items-center gap-2 mb-1">
                    <XCircle className="w-4 h-4 text-status-error" />
                    <span className="text-xs font-medium text-status-error">Error</span>
                  </div>
                  <p className="text-xs text-status-error">{event.tool_error}</p>
                </div>
              )}
            </div>
          )}

          {/* Artifact Link */}
          {event.artifact_id && (
            <div className="mt-3 pt-3 border-t border-border">
              <div className="flex items-center gap-2 text-sm text-accent hover:text-accent-secondary cursor-pointer">
                <FileText className="w-4 h-4" />
                <span>View Artifact</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getEventConfig(eventType: string, level: string) {
  // Determine icon based on event type
  let icon = <Activity className="w-4 h-4" />;
  let bgColor = 'bg-status-running/10';
  let textColor = 'text-status-running';

  if (eventType.includes('completed') || eventType.includes('success')) {
    icon = <CheckCircle2 className="w-4 h-4 text-status-completed" />;
    bgColor = 'bg-status-completed/10';
    textColor = 'text-status-completed';
  } else if (eventType.includes('failed') || eventType.includes('error') || level === 'error') {
    icon = <XCircle className="w-4 h-4 text-status-error" />;
    bgColor = 'bg-status-error/10';
    textColor = 'text-status-error';
  } else if (eventType.includes('approval') || level === 'warning') {
    icon = <AlertTriangle className="w-4 h-4 text-status-paused" />;
    bgColor = 'bg-status-paused/10';
    textColor = 'text-status-paused';
  } else if (level === 'info' || level === 'debug') {
    icon = <Info className="w-4 h-4 text-status-idle" />;
    bgColor = 'bg-status-idle/10';
    textColor = 'text-status-idle';
  }

  // Level badge color
  let levelColor = 'bg-status-idle/10 text-status-idle border border-status-idle/20';
  if (level === 'error' || level === 'critical') {
    levelColor = 'bg-status-error/10 text-status-error border border-status-error/20';
  } else if (level === 'warning') {
    levelColor = 'bg-status-paused/10 text-status-paused border border-status-paused/20';
  } else if (level === 'info') {
    levelColor = 'bg-status-running/10 text-status-running border border-status-running/20';
  }

  return { icon, bgColor, textColor, levelColor };
}

function formatEventType(eventType: string): string {
  return eventType
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' › ');
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;

  return date.toLocaleString();
}
