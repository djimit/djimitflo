import { useEffect, useRef, useCallback, useState } from 'react';
import type { WebSocketMessage, WebSocketEventType } from '@djimitflo/shared';
import { WS_CLOSE_CODES } from '@djimitflo/shared';
import { AUTH_SESSION_KEY, refreshSession, useAuthStore } from '../lib/auth-store';

function getDefaultWsUrl(): string {
  if (!import.meta.env.PROD && import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
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
  const sessionToken = useAuthStore((state) => state.token);
  const ws = useRef<WebSocket | null>(null);
  const handlers = useRef<Map<WebSocketEventType | 'all', Set<MessageHandler>>>(new Map());
  const reconnectTimeout = useRef<number | undefined>(undefined);
  const isConnecting = useRef(false);
  const authFailed = useRef(false);
  const authRefreshUsed = useRef(false);
  const enabled = useRef(false);
  const [isConnected, setIsConnected] = useState(false);

  const connect = useCallback(() => {
    if (!enabled.current) return;
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
    // SECURITY: Token sent as subprotocol (not query string) to avoid
    // token leakage via access logs, browser history, or referrer headers.
    // Server must validate the "bearer" subprotocol and extract the token.
    const socketProtocol = `bearer.${token}`;

    try {
      const socket = new WebSocket(WS_BASE_URL, socketProtocol);
      ws.current = socket;

      socket.onopen = () => {
        if (ws.current !== socket) return;
        isConnecting.current = false;
        ws.current = socket;
        authRefreshUsed.current = false;
        setIsConnected(true);
      };

      socket.onmessage = (event) => {
        if (ws.current !== socket) return;
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          const dispatch = (item: WebSocketMessage) => {
            handlers.current.get(item.type)?.forEach(handler => handler(item));
            handlers.current.get('all')?.forEach(handler => handler(item));
          };
          if (message.type === 'execution.batch' && Array.isArray((message.payload as any)?.events)) {
            (message.payload as any).events.forEach(dispatch);
          } else dispatch(message);
        } catch (_error) {
          // ignore parse errors
        }
      };

      socket.onerror = () => {
        if (ws.current !== socket) return;
        isConnecting.current = false;
      };

      socket.onclose = (event) => {
        if (ws.current !== socket) return;
        isConnecting.current = false;
        ws.current = null;
        setIsConnected(false);

        if (AUTH_CLOSE_CODES.has(event.code as number)) {
          authFailed.current = true;
          if (event.code === WS_CLOSE_CODES.AUTH_EXPIRED && !authRefreshUsed.current) {
            authRefreshUsed.current = true;
            void refreshSession(token).then(() => {
              if (!enabled.current) return;
              authFailed.current = false;
              connect();
            }).catch(() => { /* Refresh rejection leaves the socket closed; no reconnect loop. */ });
          }
          return;
        }

        if (enabled.current) {
          reconnectTimeout.current = window.setTimeout(connect, 3000);
        }
      };
    } catch (_error) {
      isConnecting.current = false;
    }
  }, []);

  const disconnect = useCallback(() => {
    enabled.current = false;
    isConnecting.current = false;
    authFailed.current = false;
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
    }
    if (ws.current) {
      const socket = ws.current;
      ws.current = null;
      socket.close();
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
      enabled.current = true;
      resetAuthFailure();
      connect();
    } else {
      disconnect();
    }
    return () => {
      disconnect();
    };
  }, [isAuthenticated, sessionToken, connect, disconnect, resetAuthFailure]);

  return {
    subscribe,
    isConnected,
    connect,
    disconnect,
  };
}
