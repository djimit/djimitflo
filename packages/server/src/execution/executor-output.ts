import type { EventEmitter } from 'events';

export function captureExecutorOutput(emitter: EventEmitter, maxBytes = 5 * 1024 * 1024) {
  let stdout = '';
  let stderr = '';
  emitter.on('output', (text: string, stream: 'stdout' | 'stderr') => {
    if (stream === 'stderr') stderr = (stderr + text).slice(-maxBytes);
    else stdout = (stdout + text).slice(-maxBytes);
  });
  return () => ({ stdout, stderr });
}
