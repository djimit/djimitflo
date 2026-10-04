import { expect, it } from 'vitest';
import { runtimeConfigView } from '../services/runtime-config-view';

it('lists flags, masks secrets by name and by value, and skips system variables', () => {
  const { entries, masked } = runtimeConfigView({
    LOOP_EVOLVE_SPECIES: 'remote@workstation/atomic@llama-router', STALL_WATCH_ENABLED: 'true',
    NVIDIA_API_KEY: 'nvapi-abcdefghijklmnop', GITHUB_TOKEN: 'ghp_x', SOCIAL_COMPAT_BASE_URL: 'https://ollama.com/v1',
    LITELLM_URL_WITH_CREDS: 'http://user:pass@host:4000', SOME_NOTE: 'sk-abcdefghijklmnopqrst',
    PATH: '/usr/bin', lower_case: 'x',
  });
  const by = Object.fromEntries(entries.map((e) => [e.name, e]));
  expect(by.LOOP_EVOLVE_SPECIES).toMatchObject({ value: 'remote@workstation/atomic@llama-router', masked: false, group: 'LOOP' });
  expect(by.SOCIAL_COMPAT_BASE_URL.masked).toBe(false);
  for (const n of ['NVIDIA_API_KEY', 'GITHUB_TOKEN', 'LITELLM_URL_WITH_CREDS', 'SOME_NOTE']) {
    expect(by[n].masked).toBe(true); expect(by[n].value).toMatch(/^set \(\d+ chars\)$/);
  }
  expect(JSON.stringify(entries)).not.toMatch(/nvapi-|ghp_x|user:pass|sk-abc/);
  expect(by.PATH).toBeUndefined(); expect(by.lower_case).toBeUndefined();
  expect(masked).toBe(4);
});
