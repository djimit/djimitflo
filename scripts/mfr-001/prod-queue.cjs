/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS: runs as a bare `node` probe in the prod container */
// MFR-001 read-only GPU yield check: remote maker jobs waiting for or running on the workstation (READONLY handle).
const D = require('better-sqlite3'); const d = new D('/data/djimitflo.sqlite', { readonly: true });
console.log(JSON.stringify(d.prepare("select count(*) n from remote_maker_jobs where status in ('queued', 'claimed')").get()));
