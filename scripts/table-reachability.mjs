import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
export function hasSqlRead(text, table) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const read = new RegExp(`\\b(?:FROM|JOIN)\\s+[\\\`\"']?${escaped}\\b`, 'i');
  // DELETE's target is a write, but SELECT/JOIN subqueries remain real reads.
  return read.test(text.replace(/\bDELETE\s+FROM\b/gi, 'DELETE_TARGET'));
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : ['.ts', '.tsx', '.js', '.mjs'].includes(extname(path)) ? [path] : [];
  });
}

function main() {
  const dbPath = resolve(process.argv[2] || join(root, '.data', 'djimitflo.sqlite'));
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  const sourceFiles = files(join(root, 'packages')).filter((file) => !file.includes('/dist/'));
  const sources = sourceFiles.map((file) => ({ file: relative(root, file), text: readFileSync(file, 'utf8') }));
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();

  const report = tables.map(({ name }) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`\\b${escaped}\\b`, 'i');
    const write = new RegExp(`\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+[\\\`\"']?${escaped}\\b`, 'i');
    const refs = sources.filter(({ text }) => word.test(text));
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((column) => column.name);
    const timeColumn = ['updated_at', 'created_at', 'timestamp', 'applied_at'].find((column) => columns.includes(column));
    return {
      table: name,
      rows: db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count,
      writers: refs.filter(({ text }) => write.test(text)).map(({ file }) => file),
      readers: refs.filter(({ text }) => hasSqlRead(text, name)).map(({ file }) => file),
      routes: refs.filter(({ file }) => file.includes('/routes/')).map(({ file }) => file),
      tests: refs.filter(({ file }) => file.includes('/__tests__/') || /\.test\./.test(file)).map(({ file }) => file),
      last_write: timeColumn ? db.prepare(`SELECT MAX("${timeColumn}") AS value FROM "${name}"`).get().value : null,
    };
  });
  db.close();

  console.log(JSON.stringify({
    database: dbPath,
    limitations: ['Static SQL regex references, not runtime execution proof.', 'Raw readers/writers include test and schema sources; use runtime-filtered graph for operational source classification.', 'Dynamic SQL, SQL comments, aliases and unusual quoted identifiers require manual tracing.'],
    tables: report.length,
    empty: report.filter((entry) => entry.rows === 0).length,
    unreachable: report.filter((entry) => entry.writers.length === 0 && entry.readers.length === 0),
    report,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
