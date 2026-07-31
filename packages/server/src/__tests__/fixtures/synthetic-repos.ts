import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface SyntheticRepo {
  path: string;
  fullName: string;
  expectedStacks: string[];
  expectedPackageManager: string;
  expectedLicense: string;
}

export function createTypeScriptMonorepo(): SyntheticRepo {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-ts-mono-"));
  mkdirSync(join(dir, "packages", "server", "src"), { recursive: true });
  mkdirSync(join(dir, "packages", "dashboard", "src"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });

  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "synthetic-ts-mono",
    private: true,
    license: "MIT",
    workspaces: ["packages/*"],
    scripts: { test: "vitest run", build: "tsc", lint: "eslint .", typecheck: "tsc --noEmit" },
  }));
  writeFileSync(join(dir, "LICENSE"), "MIT License\n\nCopyright (c) 2026 Synthetic");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  writeFileSync(join(dir, "AGENTS.md"), "# Agents\n\nRun `npm test`.");
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n");

  writeFileSync(join(dir, "packages", "server", "package.json"), JSON.stringify({
    name: "server",
    scripts: { test: "vitest run" },
    dependencies: { express: "^4.18.0" },
  }));
  writeFileSync(join(dir, "packages", "server", "src", "index.ts"), "import express from 'express';\n");
  writeFileSync(join(dir, "packages", "dashboard", "package.json"), JSON.stringify({
    name: "dashboard",
    scripts: { build: "vite build" },
    dependencies: { react: "^18.0.0" },
  }));
  writeFileSync(join(dir, "packages", "dashboard", "src", "App.tsx"), "export function App() { return <div />; }\n");

  return {
    path: dir,
    fullName: "synthetic/ts-mono",
    expectedStacks: ["node", "typescript"],
    expectedPackageManager: "npm",
    expectedLicense: "MIT",
  };
}

export function createPythonPackage(): SyntheticRepo {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-python-"));
  mkdirSync(join(dir, "src", "synthetic"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });

  writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = 'synthetic'\nversion = '0.1.0'\nlicense = {text = 'Apache-2.0'}\n");
  writeFileSync(join(dir, "LICENSE"), "Apache License 2.0\n");
  writeFileSync(join(dir, "requirements.txt"), "requests>=2.28\npytest>=7.0\n");
  writeFileSync(join(dir, "src", "synthetic", "__init__.py"), "def hello():\n    return 'world'\n");
  writeFileSync(join(dir, "src", "synthetic", "core.py"), "class Core:\n    pass\n");
  writeFileSync(join(dir, "tests", "test_core.py"), "from synthetic.core import Core\n");

  return {
    path: dir,
    fullName: "synthetic/python",
    expectedStacks: ["python"],
    expectedPackageManager: "unknown",
    expectedLicense: "Apache-2.0",
  };
}

export function createMinimalRepo(): SyntheticRepo {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-minimal-"));
  writeFileSync(join(dir, "README.md"), "# Minimal\n");

  return {
    path: dir,
    fullName: "synthetic/minimal",
    expectedStacks: [],
    expectedPackageManager: "unknown",
    expectedLicense: "unknown",
  };
}

export function cleanupRepo(repo: SyntheticRepo) {
  rmSync(repo.path, { recursive: true, force: true });
}
