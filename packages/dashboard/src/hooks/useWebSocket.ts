import { useEffect, useRef, useCallback, useState } from 'react';
import type { WebSocketMessage, WebSocketEventType } from '@djimitflo/shared';
import { WS_CLOSE_CODES } from '@djimitflo/shared';

const AUTH_SESSION_KEY = 'djimitflo_auth_session';

function getDefaultWsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3001';
  return `${protocol}//${host}/ws`;
}

const WS_BASE_URL = getDefaultWsUrl();

type MessageHandler = (message: WebSocketMessage) => void;

const AUTH_CLOSE_CODES: Set<number> = new Set([
  WS_CLOSE_CODES.AUTH_REQUIRED as number,
  WS_CLOSE_CODES.AUTH_INVALID as number,
  WS_CLOSE_CODES.AUTH_EXPIRED as number,
]);

export function useWebSocket(isAuthenticated: boolean) {
  const ws = useRef<WebSocket | null>(null);
  const handlers = useRef<Map<WebSocketEventType | 'all', Set<MessageHandler>>>(new Map());
  const reconnectTimeout = useRef<number>();
  const isConnecting = useRef(false);
  const authFailed = useRef(false);
  const [isConnected, setIsConnected] = useState(false);

  const connect = useCallback(() => {
    if (isConnecting.current || (ws.current && ws.current.readyState === WebSocket.OPEN)) {
      return;
    }

    const token = localStorage.getItem(AUTH_SESSION_KEY);
    if (!token) {
      return;
    }

    if (authFailed.current) {
      return;
    }

    isConnecting.current = true;
    const url = `${WS_BASE_URL}?token=${encodeURIComponent(token)}`;

    try {
      const socket = new WebSocket(url);

      socket.onopen = () => {
        isConnecting.current = false;
        ws.current = socket;
        setIsConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);

          const typeHandlers = handlers.current.get(message.type);
          if (typeHandlers) {
            typeHandlers.forEach(handler => handler(message));
          }

          const allHandlers = handlers.current.get('all');
          if (allHandlers) {
            allHandlers.forEach(handler => handler(message));
          }
        } catch (_error) {
          // ignore parse errors
        }
      };

      socket.onerror = () => {
        isConnecting.current = false;
      };

      socket.onclose = (event) => {
        isConnecting.current = false;
        ws.current = null;
        setIsConnected(false);

        if (AUTH_CLOSE_CODES.has(event.code as number)) {
          authFailed.current = true;
          return;
        }

        reconnectTimeout.current = window.setTimeout(() => {
          connect();
        }, 3000);
      };
    } catch (_error) {
      isConnecting.current = false;
    }
  }, []);

  const disconnect = useCallback(() => {
    authFailed.current = false;
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
    }
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
    setIsConnected(false);
  }, []);

  const resetAuthFailure = useCallback(() => {
    authFailed.current = false;
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
    if (isAuthenticated) {
      resetAuthFailure();
      connect();
    } else {
      disconnect();
    }
    return () => {
      disconnect();
    };
  }, [isAuthenticated, connect, disconnect, resetAuthFailure]);

  return {
    subscribe,
    isConnected,
    connect,
    disconnect,
  };
}
