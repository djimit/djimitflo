import { defineConfig } from 'vitest/config';

// ponytail: enkel jsdom als environment, geen setup-bestand. Tests stubben wat
// ze nodig hebben (localStorage, fetch); upgrade-pad is setupFiles als dat
// ondupliceerbaar wordt.
export default defineConfig({
  test: {
    environment: 'jsdom',
  },
});
