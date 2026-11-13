import { describe, expect, it } from 'vitest';
import { inCommons, agentGroup } from '../services/agent-connection-state';

describe('agent-connection-state exports (inCommons, agentGroup)', () => {
  describe('inCommons', () => {
    it('is true when metadata.commons_resident is set', () => {
      expect(inCommons({ metadata: { commons_resident: true } })).toBe(true);
    });

    it('is true when metadata.social_runtime is present', () => {
      expect(inCommons({ metadata: { social_runtime: { enabled: true } } })).toBe(true);
    });

    it('is true when metadata.social_runtime is an empty object (presence alone counts)', () => {
      expect(inCommons({ metadata: { social_runtime: {} } })).toBe(true);
    });

    it('is false for a factory worker with neither marker', () => {
      expect(inCommons({ metadata: {} })).toBe(false);
    });

    it('is false when metadata is absent', () => {
      expect(inCommons({})).toBe(false);
    });

    it('is false when metadata is null and treats it as empty', () => {
      expect(inCommons({ metadata: null })).toBe(false);
    });

    it('is false when metadata is a non-object primitive', () => {
      expect(inCommons({ metadata: 'commons_resident' })).toBe(false);
      expect(inCommons({ metadata: 42 })).toBe(false);
    });
  });

  describe('agentGroup', () => {
    it('classifies a typed agent as a fleet_agent even when it is also a Commons resident', () => {
      expect(agentGroup({ agent_type: 'hermes', metadata: { commons_resident: true } })).toBe('fleet_agent');
    });

    it('classifies an untyped Commons resident as commons_resident', () => {
      expect(agentGroup({ metadata: { social_runtime: { enabled: true } } })).toBe('commons_resident');
    });

    it('classifies an agent with only commons_resident metadata as commons_resident', () => {
      expect(agentGroup({ metadata: { commons_resident: true } })).toBe('commons_resident');
    });

    it('classifies an agent with no type and no Commons markers as a factory_worker', () => {
      expect(agentGroup({ metadata: {} })).toBe('factory_worker');
    });

    it('classifies an agent with no metadata as a factory_worker', () => {
      expect(agentGroup({})).toBe('factory_worker');
    });

    it('treats a null agent_type as absent (falls through to Commons / factory logic)', () => {
      expect(agentGroup({ agent_type: null, metadata: { commons_resident: true } })).toBe('commons_resident');
      expect(agentGroup({ agent_type: null, metadata: {} })).toBe('factory_worker');
    });
  });
});
