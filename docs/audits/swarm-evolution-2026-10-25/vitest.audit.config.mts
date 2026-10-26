import { defineConfig, mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import base from './vitest.config.mts';
export default mergeConfig(base, defineConfig({resolve:{alias:[
 {find:/^@djimitflo\/shared$/,replacement:fileURLToPath(new URL('../shared/src/index.ts',import.meta.url))},
 {find:'@djimitflo/shared/jwt',replacement:fileURLToPath(new URL('../shared/src/jwt.ts',import.meta.url))}
]}}));
