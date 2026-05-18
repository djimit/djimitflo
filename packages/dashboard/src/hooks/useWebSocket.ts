/**
 * WebSocket hook for real-time updates
 */

import { useEffect, useRef, useCallback } from 'react';
import type { WebSocketMessage, WebSocketEventType } from '@djimitflo/shared';

function getDefaultWsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3001';
  return `${protocol}//${host}/ws`;
}

const WS_URL = getDefaultWsUrl();

type MessageHandler = (message: WebSocketMessage) => void;

export function useWebSocket() {
  const ws = useRef<WebSocket | null>(null);
  const handlers = useRef<Map<WebSocketEventType | 'all', Set<MessageHandler>>>(new Map());
  const reconnectTimeout = useRef<number>();
  const isConnecting = useRef(false);

  const connect = useCallback(() => {
    if (isConnecting.current || (ws.current && ws.current.readyState === WebSocket.OPEN)) {
      return;
    }

    isConnecting.current = true;
    console.log('[WebSocket] Connecting to', WS_URL);

    try {
      const socket = new WebSocket(WS_URL);

      socket.onopen = () => {
        console.log('[WebSocket] Connected');
        isConnecting.current = false;
        ws.current = socket;
      };

      socket.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          
          // Call type-specific handlers
          const typeHandlers = handlers.current.get(message.type);
          if (typeHandlers) {
            typeHandlers.forEach(handler => handler(message));
          }

          // Call global handlers
          const allHandlers = handlers.current.get('all');
          if (allHandlers) {
            allHandlers.forEach(handler => handler(message));
          }
        } catch (error) {
          console.error('[WebSocket] Failed to parse message:', error);
        }
      };

      socket.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        isConnecting.current = false;
      };

      socket.onclose = () => {
        console.log('[WebSocket] Disconnected, reconnecting in 3s...');
        isConnecting.current = false;
        ws.current = null;

        // Reconnect after 3 seconds
        reconnectTimeout.current = window.setTimeout(() => {
          connect();
        }, 3000);
      };
    } catch (error) {
      console.error('[WebSocket] Connection failed:', error);
      isConnecting.current = false;
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
    }
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
  }, []);

  const subscribe = useCallback((eventType: WebSocketEventType | 'all', handler: MessageHandler) => {
    if (!handlers.current.has(eventType)) {
      handlers.current.set(eventType, new Set());
    }
    handlers.current.get(eventType)!.add(handler);

    return () => {
      const typeHandlers = handlers.current.get(eventType);
      if (typeHandlers) {
        typeHandlers.delete(handler);
      }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    subscribe,
    isConnected: ws.current?.readyState === WebSocket.OPEN,
  };
}
