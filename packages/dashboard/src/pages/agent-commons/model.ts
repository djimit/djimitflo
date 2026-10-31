import { Compass, Lightbulb, MessageCircle } from 'lucide-react';
import type { LureStatus, SocialAgentPresence, SocialThread } from '../../lib/api';
import { fmtDate } from '../../lib/format';

export type ConstellationNode = { id: string; name: string; x: number; y: number; present: boolean; lured: boolean; threads: number; hue: number };
export type ConstellationEdge = { from: string; to: string; x1: number; y1: number; x2: number; y2: number; count: number; stage: SocialThread['stage'] };

export const STAGE = {
  asked: { label: 'Curious', color: 'rgb(80 200 255)', icon: Compass },
  responding: { label: 'In conversation', color: 'rgb(250 204 21)', icon: MessageCircle },
  learned: { label: 'Reflection', color: 'rgb(34 197 94)', icon: Lightbulb },
} as const;

export const LURE_COLOR = 'rgb(217 70 239)';

export function agentHue(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/** Agents still on the hook: invited by an open lure, not yet bitten. */
export function luredAgents(lures: LureStatus | null): Map<string, string> {
  const lured = new Map<string, string>();
  for (const lure of lures?.lures || []) {
    for (const invitee of lure.invitees) {
      if ((invitee.state === 'invited' || invitee.state === 'seen') && !lured.has(invitee.agent_id)) lured.set(invitee.agent_id, invitee.name);
    }
  }
  return lured;
}

/**
 * Agents on a ring; every pair that took part in the same thread gets one edge (count = shared threads) carrying the
 * furthest stage reached. Co-participation only — not a record of communication or learning. Lured-but-silent agents appear hollow.
 */
export function layoutConstellation(agents: SocialAgentPresence[], threads: SocialThread[], size = 320, lured: Map<string, string> = new Map()): { nodes: ConstellationNode[]; edges: ConstellationEdge[] } {
  const ids = [...new Set([...agents.map((agent) => agent.id), ...threads.flatMap((thread) => thread.participants), ...lured.keys()])].sort();
  const centre = size / 2;
  const radius = size / 2 - 36;
  const nodes = ids.map((id, index) => {
    const angle = (index / Math.max(1, ids.length)) * Math.PI * 2 - Math.PI / 2;
    const agent = agents.find((candidate) => candidate.id === id);
    return {
      id, name: agent?.name || lured.get(id) || id, hue: agentHue(id), present: agent?.present || false, lured: !agent?.present && lured.has(id),
      x: ids.length === 1 ? centre : centre + Math.cos(angle) * radius, y: ids.length === 1 ? centre : centre + Math.sin(angle) * radius,
      threads: threads.filter((thread) => thread.participants.includes(id)).length,
    };
  });
  const rank = { asked: 0, responding: 1, learned: 2 };
  const edges = new Map<string, ConstellationEdge>();
  for (const thread of threads) {
    for (let left = 0; left < thread.participants.length; left += 1) {
      for (let right = left + 1; right < thread.participants.length; right += 1) {
        const from = nodes.find((node) => node.id === thread.participants[left]);
        const to = nodes.find((node) => node.id === thread.participants[right]);
        if (!from || !to) continue;
        const key = `${from.id}|${to.id}`;
        const current = edges.get(key);
        edges.set(key, {
          from: from.id, to: to.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y, count: (current?.count || 0) + 1,
          stage: current && rank[current.stage] > rank[thread.stage] ? current.stage : thread.stage,
        });
      }
    }
  }
  return { nodes, edges: [...edges.values()] };
}

/** Heartbeats show availability; only submitted replies count as participation. */
export function runtimeParticipation(threads: SocialThread[]) {
  const participants = new Map<string, { agent: string; runtime: string; model: string; replies: number; lastReply: string }>();
  for (const message of threads.flatMap((thread) => thread.messages)) {
    if (message.action === 'social.question' || !message.runtime) continue;
    const key = JSON.stringify([message.from, message.runtime, message.model_id]);
    const previous = participants.get(key);
    participants.set(key, {
      agent: message.from, runtime: message.runtime, model: message.model_id || 'model unknown',
      replies: (previous?.replies || 0) + 1,
      lastReply: previous && previous.lastReply > message.timestamp ? previous.lastReply : message.timestamp,
    });
  }
  return [...participants.values()];
}

export const time = (value: string | null) => fmtDate(value);

export const PAGE_SIZE = 20;
export const RECORD_COLOR = 'rgb(148 163 184)';

/**
 * AC-02: the thread shown on the right. A selected thread stays selected across the 8-second refresh even when it drops
 * off the loaded page (the last loaded copy is kept); only without a selection does the newest thread show.
 */
export function resolveActiveThread(threads: SocialThread[], selectedId: string | null, previous: SocialThread | null): SocialThread | null {
  if (!selectedId) return threads[0] ?? null;
  return threads.find((thread) => thread.id === selectedId) ?? (previous?.id === selectedId ? previous : null);
}
