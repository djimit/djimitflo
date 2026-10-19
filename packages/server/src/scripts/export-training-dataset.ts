/**
 * Read-only training-dataset export (services/training-dataset.ts) — operator-run, never scheduled.
 *   TRAINING_DATASET_EXPORT=shadow node dist/scripts/export-training-dataset.js --db <path> --out <file.jsonl>
 * Opens the database read-only, writes one JSON row per line to a NEW file (never overwrites), prints the counts summary.
 * Refused (exit 2) unless TRAINING_DATASET_EXPORT=shadow, or when --out lies under /workspace or this repository.
 * Exit: 0 written, 2 refused, 64 usage.
 */
import path from 'path';
import { runTrainingDatasetExport } from '../services/training-dataset';

// packages/server/{src,dist}/scripts → the repository root (an output path under it is refused)
process.exit(runTrainingDatasetExport(process.argv.slice(2), process.env, path.resolve(__dirname, '../../../..')));
