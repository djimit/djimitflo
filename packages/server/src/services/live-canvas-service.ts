/**
 * LiveCanvasService — real-time agent output streaming to dashboard clients.
 *
 * Provides a live canvas where agents can render:
 * - Progress indicators (spinner, progress bar)
 * - Code diffs (inline)
 * - Thinking/reasoning streams
 * - Tool call results (formatted)
 * - File previews
 * - Interactive approval prompts
 *
 * Inspired by Claude Code's streaming output and OpenClaw's Live Canvas.
 */

import { WebSocket } from 'ws';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

type CanvasMessageType =
  | 'thinking' | 'tool_call' | 'tool_result' | 'code_diff'
  | 'progress' | 'file_preview' | 'approval_prompt' | 'error'
  | 'complete' | 'status';

interface CanvasMessage {
  id: string;
  type: CanvasMessageType;
  runId: string;
  agentId?: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

interface CanvasSession {
  id: string;
  runId: string;
  clients: Set<WebSocket>;
  messages: CanvasMessage[];
  status: 'active' | 'paused' | 'completed' | 'error';
  createdAt: string;
}

export class LiveCanvasService {
  private sessions: Map<string, CanvasSession> = new Map();

  constructor(_db: Database) {
    // Database available for persistent canvas history
  }

  /**
   * Create a new canvas session for a loop run.
   */
  createSession(runId: string): CanvasSession {
    const session: CanvasSession = {
      id: randomUUID(),
      runId,
      clients: new Set(),
      messages: [],
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(runId, session);
    return session;
  }

  /**
   * Connect a WebSocket client to a canvas session.
   */
  connectClient(runId: string, client: WebSocket): boolean {
    let session = this.sessions.get(runId);
    if (!session) {
      session = this.createSession(runId);
    }

    session.clients.add(client);

    // Send history to newly connected client
    for (const msg of session.messages) {
      this.sendToClient(client, msg);
    }

    return true;
  }

  /**
   * Disconnect a WebSocket client.
   */
  disconnectClient(runId: string, client: WebSocket): void {
    const session = this.sessions.get(runId);
    if (session) {
      session.clients.delete(client);
    }
  }

  /**
   * Stream a thinking/reasoning message.
   */
  streamThinking(runId: string, content: string, agentId?: string): void {
    this.broadcast({
      id: randomUUID(),
      type: 'thinking',
      runId,
      agentId,
      content,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Stream a tool call.
   */
  streamToolCall(runId: string, toolName: string, args: Record<string, unknown>, agentId?: string): void {
    this.broadcast({
      id: randomUUID(),
      type: 'tool_call',
      runId,
      agentId,
      content: toolName,
      metadata: { args },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Stream a tool result.
   */
  streamToolResult(runId: string, toolName: string, result: string, agentId?: string): void {
    this.broadcast({
      id: randomUUID(),
      type: 'tool_result',
      runId,
      agentId,
      content: result.slice(0, 2000), // Truncate large outputs
      metadata: { tool: toolName, fullSize: result.length },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Stream a code diff.
   */
  streamCodeDiff(runId: string, filePath: string, diff: string, agentId?: string): void {
    this.broadcast({
      id: randomUUID(),
      type: 'code_diff',
      runId,
      agentId,
      content: diff,
      metadata: { filePath },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Stream progress update.
   */
  streamProgress(runId: string, current: number, total: number, label: string): void {
    this.broadcast({
      id: randomUUID(),
      type: 'progress',
      runId,
      content: label,
      metadata: { current, total, percent: Math.round((current / total) * 100) },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Stream an approval prompt.
   */
  streamApprovalPrompt(runId: string, action: string, reason: string, approvalId: string): void {
    this.broadcast({
      id: randomUUID(),
      type: 'approval_prompt',
      runId,
      content: action,
      metadata: { reason, approvalId },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Stream an error.
   */
  streamError(runId: string, error: string, agentId?: string): void {
    this.broadcast({
      id: randomUUID(),
      type: 'error',
      runId,
      agentId,
      content: error,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Mark a session as complete.
   */
  completeSession(runId: string, summary: string): void {
    const session = this.sessions.get(runId);
    if (session) {
      session.status = 'completed';
    }

    this.broadcast({
      id: randomUUID(),
      type: 'complete',
      runId,
      content: summary,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get session status.
   */
  getSessionStatus(runId: string): {
    status: string;
    messageCount: number;
    clientCount: number;
  } | null {
    const session = this.sessions.get(runId);
    if (!session) return null;

    return {
      status: session.status,
      messageCount: session.messages.length,
      clientCount: session.clients.size,
    };
  }

  /**
   * List all active sessions.
   */
  listSessions(): Array<{
    runId: string;
    status: string;
    messageCount: number;
    clientCount: number;
    createdAt: string;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      runId: s.runId,
      status: s.status,
      messageCount: s.messages.length,
      clientCount: s.clients.size,
      createdAt: s.createdAt,
    }));
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private broadcast(message: CanvasMessage): void {
    const session = this.sessions.get(message.runId);
    if (!session) return;

    // Store message in history
    session.messages.push(message);

    // Send to all connected clients
    for (const client of session.clients) {
      this.sendToClient(client, message);
    }
  }

  private sendToClient(client: WebSocket, message: CanvasMessage): void {
    try {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify(message));
      }
    } catch { /* client disconnected */ }
  }
}
