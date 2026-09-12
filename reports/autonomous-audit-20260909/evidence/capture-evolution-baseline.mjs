import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceState} from '../../../scripts/assurance-truth.mjs';
const root=new URL('../../../',import.meta.url).pathname;
const command=(name,args)=>execFileSync(name,args,{cwd:root,encoding:'utf8'}).trim();
const hash=path=>createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex');
const prior=JSON.parse(readFileSync(new URL('verification-summary.json',import.meta.url),'utf8'));
const reference=command('git',['ls-remote','https://github.com/djimit/djimitflo.git','refs/heads/main']).split(/\s+/)[0];
const live=await fetch('https://djimitflo.agentical.nl/',{method:'HEAD',signal:AbortSignal.timeout(10000)});
const local=await fetch('http://127.0.0.1:3187/health',{signal:AbortSignal.timeout(10000)});
const health=await local.json();assert.equal(local.status,200);
const registration=JSON.parse(readFileSync(new URL('evolution-goals-registered.json',import.meta.url),'utf8'));assert.equal(registration.goals.length,6);
console.log(JSON.stringify({schema_version:1,recorded_at:new Date().toISOString(),state:'BASELINE_RECORDED',source:sourceState(root),branch:command('git',['branch','--show-current']),github_main:reference,
  local_runtime:{base:'http://127.0.0.1:3187',health,profile:'api',external_connections:'Ollama/Qdrant/UAMS explicitly loopback-refused; event-bus polling not configured'},
  production_reference:{url:'https://djimitflo.agentical.nl/',http_status:live.status,content_type:live.headers.get('content-type'),authenticated_capabilities:'UNKNOWN; no authenticated production traversal in this checkpoint'},
  previous_verified_checkpoint:{tests:prior.checks.tests,mutation:prior.checks.mutation,mission_complete:false,summary_sha256:hash('verification-summary.json'),report_sha256:hash('../FINAL_STATE.md'),evidence:'lifecycle-tests-final.log; approval-range-mutation-final.log; lifecycle-browser-proof.json',meaning:'historical executed checkpoint, not a rerun for current edits'},
  new_experiment_baselines:['cognitive evolution fixed-episode RED probe','outcome-ingest-chain-red.log','self-improvement-closure-red.log'],
  goals:registration.goals.map(g=>({id:g.id,key:g.metadata.goal_batch.id,status:g.status})),
  limits:['Source snapshot taken during active development; each controlled experiment must bind its own before/after artifact identities','Public HTTP200 is reachability only','No new provider, authenticated production, held-out intelligence improvement or recurring background monitor claimed']},null,2));
