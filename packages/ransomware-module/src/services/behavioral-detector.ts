import { EventEmitter } from 'events';
import { BehavioralSignal, BehavioralThresholds, RansomwareEvent } from '../types';

interface TimedEvent {
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export class BehavioralDetector {
  private thresholds: BehavioralThresholds;
  private eventEmitter: EventEmitter;
  private fileRenameEvents: Map<string, TimedEvent[]> = new Map();
  private outboundConnections: Map<string, TimedEvent[]> = new Map();
  private entropySamples: Map<string, TimedEvent[]> = new Map();

  constructor(thresholds: BehavioralThresholds, eventEmitter: EventEmitter) {
    this.thresholds = thresholds;
    this.eventEmitter = eventEmitter;
  }

  recordFileRename(agentId: string, metadata?: Record<string, unknown>): BehavioralSignal | null {
    return this.checkThreshold(
      'massFileRename',
      this.fileRenameEvents,
      agentId,
      'mass_file_rename',
      metadata
    );
  }

  recordEntropySample(agentId: string, entropy: number, metadata?: Record<string, unknown>): BehavioralSignal | null {
    this.recordEvent(this.entropySamples, agentId, { ...metadata, actual: entropy });

    if (entropy > this.thresholds.entropySpike.threshold) {
      const signal: BehavioralSignal = {
        type: 'entropy_spike',
        threshold: this.thresholds.entropySpike.threshold,
        actual: entropy,
        windowMs: this.thresholds.entropySpike.windowMs,
        context: metadata || {}
      };
      this.emitBehavioral(signal, agentId);
      return signal;
    }
    return null;
  }

  recordOutboundConnection(agentId: string, destination: string, metadata?: Record<string, unknown>): BehavioralSignal | null {
    this.recordEvent(this.outboundConnections, agentId, { ...metadata, destination });
    return this.checkBeaconPattern(agentId, destination, metadata);
  }

  private checkThreshold(
    thresholdKey: keyof BehavioralThresholds,
    eventStore: Map<string, TimedEvent[]>,
    agentId: string,
    signalType: BehavioralSignal['type'],
    metadata?: Record<string, unknown>
  ): BehavioralSignal | null {
    this.recordEvent(eventStore, agentId, metadata);
    const threshold = this.thresholds[thresholdKey];
    const events = this.getRecentEvents(eventStore, agentId, threshold.windowMs);

    if (events.length >= threshold.threshold) {
      const signal: BehavioralSignal = {
        type: signalType,
        threshold: threshold.threshold,
        actual: events.length,
        windowMs: threshold.windowMs,
        context: metadata || {}
      };
      this.emitBehavioral(signal, agentId);
      return signal;
    }
    return null;
  }

  private checkBeaconPattern(agentId: string, destination: string, metadata?: Record<string, unknown>): BehavioralSignal | null {
    const events = this.outboundConnections.get(agentId) || [];
    if (events.length < 3) return null;

    const recentEvents = this.getRecentEvents(this.outboundConnections, agentId, this.thresholds.outboundBeacon.windowMs);
    if (recentEvents.length < 3) return null;

    const intervals: number[] = [];
    for (let i = 1; i < recentEvents.length; i++) {
      intervals.push(recentEvents[i].timestamp - recentEvents[i - 1].timestamp);
    }

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((sum, iv) => sum + Math.abs(iv - avgInterval), 0) / intervals.length;
    const consistencyThreshold = avgInterval * 0.1;

    if (variance <= consistencyThreshold && avgInterval > 60000) {
      const signal: BehavioralSignal = {
        type: 'outbound_beacon',
        threshold: this.thresholds.outboundBeacon.threshold,
        actual: recentEvents.length,
        windowMs: this.thresholds.outboundBeacon.windowMs,
        context: { destination, avgIntervalMs: avgInterval, varianceMs: variance, ...metadata }
      };
      this.emitBehavioral(signal, agentId);
      return signal;
    }

    return null;
  }

  private recordEvent(store: Map<string, TimedEvent[]>, agentId: string, metadata?: Record<string, unknown>): void {
    let events = store.get(agentId);
    if (!events) {
      events = [];
      store.set(agentId, events);
    }
    events.push({ timestamp: Date.now(), metadata });
  }

  private getRecentEvents(store: Map<string, TimedEvent[]>, agentId: string, windowMs: number): TimedEvent[] {
    const events = store.get(agentId) || [];
    const cutoff = Date.now() - windowMs;
    return events.filter(e => e.timestamp >= cutoff);
  }

  private emitBehavioral(signal: BehavioralSignal, agentId: string): void {
    const event: RansomwareEvent = {
      type: 'ransomware:behavioral',
      payload: { agentId, signal },
      timestamp: new Date()
    };
    this.eventEmitter.emit(event.type, event);
  }

  reset(agentId: string): void {
    this.fileRenameEvents.delete(agentId);
    this.outboundConnections.delete(agentId);
    this.entropySamples.delete(agentId);
  }
}
