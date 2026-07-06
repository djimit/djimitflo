import Database from 'better-sqlite3';
import { VectorMemoryService } from '../services/vector-memory-service';
import { TrajectoryStore } from '../services/trajectory-store';

const db = new Database('../../.data/djimitflo.sqlite');

console.log('=== Vector Memory Test ===');
const vmem = new VectorMemoryService(db);
console.log('Initial stats:', vmem.getStats());

// Store test memories
const m1 = vmem.storeMemory({ content: 'TypeScript generics improve type safety', metadata: { test: true } });
const m2 = vmem.storeMemory({ content: 'Vector embeddings enable semantic search', metadata: { test: true } });
const m3 = vmem.storeMemory({ content: 'Self-learning systems adapt from feedback', metadata: { test: true } });
console.log('Stored 3 memories');

// Search
const results = vmem.search('TypeScript type safety', 5, 0.1);
console.log('Search results:', results.length);
for (const r of results) {
  console.log('  ', r.id.slice(0,12), r.score.toFixed(3), r.content.slice(0, 50));
}

// Record feedback
vmem.recordFeedback(m1.id, 1.0);
vmem.recordFeedback(m2.id, 0.3);
console.log('Feedback recorded');

// Search again (should re-rank)
const results2 = vmem.search('TypeScript type safety', 5, 0.1);
console.log('Search after feedback:', results2.length);
for (const r of results2) {
  console.log('  ', r.id.slice(0,12), r.score.toFixed(3), r.content.slice(0, 50));
}

console.log('\n=== Trajectory Store Test ===');
const traj = new TrajectoryStore(db);
console.log('Stats:', traj.getStats());

// Record trajectory
traj.recordStep({ runId: 'test-run-1', actionType: 'plan', capabilityId: 'test', runtime: 'mock', outcome: 'success', durationMs: 100 });
traj.recordStep({ runId: 'test-run-1', actionType: 'execute', capabilityId: 'test', runtime: 'mock', outcome: 'success', durationMs: 500 });
traj.recordStep({ runId: 'test-run-1', actionType: 'verify', capabilityId: 'test', runtime: 'mock', outcome: 'success', durationMs: 200 });
console.log('Recorded 3 trajectory steps');

const summary = traj.getTrajectorySummary('test-run-1');
console.log('Trajectory summary:', summary);

console.log('\nStats after:', traj.getStats());

db.close();
console.log('\nDone!');
