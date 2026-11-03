#!/usr/bin/env node
// E1 (docs/research/eco/E1-RRF_PROTOCOL.md): score raw vs per-source min-max vs RRF k=60 on an EXPORTED labelled set.
// Offline: reads one JSON file, never opens a database, never calls the network. Runs against the compiled server
// (npm run build:server), or E1_DIST=<path to dist/services/retrieval-eval.js>.
// Input: { "label_source": "<one human label source>", "queries": [ { "id", "relevant": [ids],
//          "candidates": [ { "id", "source", "score", "trust_level" } ] } ] }
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/e1-rrf-score.mjs <export.json>'); process.exit(2); }
const { scoreE1 } = require(process.env.E1_DIST || path.join(here, '..', 'packages', 'server', 'dist', 'services', 'retrieval-eval.js'));

const data = JSON.parse(readFileSync(file, 'utf8'));
const source = data.label_source;
if (typeof source !== 'string' || !source) { console.error('E1: label_source is required (a single human label source)'); process.exit(2); }
if (/jev|llm|model|synthetic|auto/i.test(source)) { console.error(`E1: label_source "${source}" is not a human label source; refused`); process.exit(2); }
const queries = Array.isArray(data.queries) ? data.queries : [];
const mixed = queries.filter((q) => q.label_source !== undefined && q.label_source !== source);
if (mixed.length) { console.error(`E1: ${mixed.length} queries carry a different label_source; one source per run`); process.exit(2); }

const report = scoreE1(queries);
console.log(JSON.stringify({ protocol: 'docs/research/eco/E1-RRF_PROTOCOL.md', label_source: source, n_input: queries.length, ...report }, null, 2));
