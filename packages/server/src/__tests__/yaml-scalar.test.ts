import { describe, expect, it } from 'vitest';
import { yamlScalar } from '../utils/yaml-scalar';

describe('yamlScalar', () => {
  it('keeps quotes and newlines inside one YAML scalar', () => {
    expect(yamlScalar('title"\nadmin: true')).toBe('"title\\"\\nadmin: true"');
  });
});
