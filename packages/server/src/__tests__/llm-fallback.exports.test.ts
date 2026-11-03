import { describe, expect, it } from 'vitest';
import {
  isConnectivityFailure,
  isLlmEndpointDown,
  resetLlmBreaker,
  llmEndpoints,
} from '../services/llm-fallback';

describe('isConnectivityFailure', () => {
  it('returns true for fetch failed', () => {
    expect(isConnectivityFailure('fetch failed')).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    expect(isConnectivityFailure('ECONNREFUSED 127.0.0.1:11434')).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isConnectivityFailure('ETIMEDOUT')).toBe(true);
  });

  it('returns true for EHOSTUNREACH', () => {
    expect(isConnectivityFailure('EHOSTUNREACH')).toBe(true);
  });

  it('returns true for ENETUNREACH', () => {
    expect(isConnectivityFailure('ENETUNREACH')).toBe(true);
  });

  it('returns true for ENOTFOUND', () => {
    expect(isConnectivityFailure('ENOTFOUND example.com')).toBe(true);
  });

  it('returns true for EAI_AGAIN', () => {
    expect(isConnectivityFailure('EAI_AGAIN')).toBe(true);
  });

  it('returns true for aborted', () => {
    expect(isConnectivityFailure('The operation was aborted')).toBe(true);
  });

  it('returns true for timed out', () => {
    expect(isConnectivityFailure('request timed out')).toBe(true);
  });

  it('returns true for timeout (single word)', () => {
    expect(isConnectivityFailure('timeout')).toBe(true);
  });

  it('returns true for socket hang up', () => {
    expect(isConnectivityFailure('socket hang up')).toBe(true);
  });

  it('returns true for HTTP 5xx', () => {
    expect(isConnectivityFailure('OpenAI-compatible request failed: HTTP 503')).toBe(true);
  });

  it('returns false for HTTP 4xx', () => {
    expect(isConnectivityFailure('Ollama request failed: 400')).toBe(false);
  });

  it('returns false for a normal success message', () => {
    expect(isConnectivityFailure('model returned unexpected json')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isConnectivityFailure('')).toBe(false);
  });

  it('is case-insensitive for Timed Out', () => {
    expect(isConnectivityFailure('Request Timed Out')).toBe(true);
  });
});

describe('isLlmEndpointDown / resetLlmBreaker', () => {
  it('reports not down for unknown endpoint', () => {
    resetLlmBreaker();
    expect(isLlmEndpointDown('ollama:unknown')).toBe(false);
  });

  it('reports down within breaker window using injected now', () => {
    resetLlmBreaker();
    const base = 1_000_000;
    expect(isLlmEndpointDown('ollama:primary', base)).toBe(false);
  });
});

describe('llmEndpoints', () => {
  it('returns only the primary when no fallback env is set', () => {
    const endpoints = llmEndpoints('http://100.77.58.72:11434', {});
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toEqual({ id: 'ollama:http://100.77.58.72:11434', kind: 'ollama', baseUrl: 'http://100.77.58.72:11434' });
  });

  it('adds a second ollama endpoint with model override', () => {
    const endpoints = llmEndpoints('http://a:11434', {
      OLLAMA_FALLBACK_URL: 'http://b:11434',
      OLLAMA_FALLBACK_MODEL: 'qwen2.5',
    });
    expect(endpoints).toHaveLength(2);
    expect(endpoints[1]).toEqual({ id: 'ollama:http://b:11434', kind: 'ollama', baseUrl: 'http://b:11434', model: 'qwen2.5' });
  });

  it('skips the second ollama endpoint when it equals the primary', () => {
    const endpoints = llmEndpoints('http://a:11434', { OLLAMA_FALLBACK_URL: 'http://a:11434' });
    expect(endpoints).toHaveLength(1);
  });

  it('adds OpenAI-compatible endpoints with key and model', () => {
    const endpoints = llmEndpoints('http://a:11434', {
      LLM_FALLBACK_OPENAI_URL: 'https://api.openai.com/v1/',
      LLM_FALLBACK_OPENAI_KEY: 'sk-test',
      LLM_FALLBACK_MODEL: 'gpt-4o',
    });
    expect(endpoints).toHaveLength(2);
    expect(endpoints[1]).toEqual({ id: 'openai:https://api.openai.com/v1/', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o' });
  });

  it('adds a second OpenAI-compatible provider (LLM_FALLBACK2_*)', () => {
    const endpoints = llmEndpoints('http://a:11434', {
      LLM_FALLBACK2_OPENAI_URL: 'https://integrate.api.nvidia.com/v1',
      LLM_FALLBACK2_OPENAI_KEY: 'nvapi-test',
      LLM_FALLBACK2_MODEL: 'kimi-k3',
    });
    expect(endpoints).toHaveLength(2);
    expect(endpoints[1]).toEqual({ id: 'openai:https://integrate.api.nvidia.com/v1', kind: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'nvapi-test', model: 'kimi-k3' });
  });

  it('combines all configured endpoints in order', () => {
    const endpoints = llmEndpoints('http://a:11434', {
      OLLAMA_FALLBACK_URL: 'http://b:11434',
      LLM_FALLBACK_OPENAI_URL: 'https://oai/v1',
      LLM_FALLBACK2_OPENAI_URL: 'https://nv/v1',
    });
    expect(endpoints.map((e) => e.kind)).toEqual(['ollama', 'ollama', 'openai', 'openai']);
  });
});