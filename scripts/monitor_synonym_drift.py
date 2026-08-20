#!/usr/bin/env python3
"""Synonym drift monitor — detect banned terms in source code.

Reads domain-terms.md files, extracts Aliases to AVOID, greps source for violations.
Filters out false positives: worktrees, tests, comments, SQL, imports, cross-BC terms.

Usage:
    python3 monitor_synonym_drift.py --specs-dir specs/ --source-dir packages/ --output report.json
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path


# Directories to exclude (false positive sources)
EXCLUDE_DIRS = [
    ".djimitflo-loop-worktrees",
    "node_modules",
    "dist",
    ".git",
    "__tests__",
    "test",
    "tests",
    "benchmarks",
    ".specify",
    "archive",
]

# File patterns to exclude
EXCLUDE_PATTERNS = [
    r"\.test\.ts$",
    r"\.spec\.ts$",
    r"\.test\.tsx$",
    r"\.spec\.tsx$",
    r"\.sql$",
]

# Cross-BC whitelist: terms that are banned in one BC but legitimate in another
# Format: {term: [file_patterns_where_legitimate]}
CROSS_BC_WHITELIST = {
    "Swarm": ["swarm_", "swarm."],  # Swarm Intelligence is a separate feature
    "Record": ["record", "Record"],  # Too generic — TypeScript built-in utility type
    "Error": ["Error", "error"],  # TypeScript built-in Error type
    "Alert": ["Alert", "alert", "Alert["],  # Early Warning domain concept
    "Service": ["Service", "service"],  # Common suffix (LoopService, etc.) — not domain
    "Worker": ["Worker", "worker"],  # Infrastructure term (WorkerPool, WorkerRuntime)
    "Bot": ["Bot", "bot"],  # Infrastructure term (TelegramBot)
    "Manager": ["Manager", "manager"],  # Infrastructure pattern
    "Helper": ["Helper", "helper"],  # Utility pattern
    "Util": ["Util", "util"],  # Utility pattern
    "Processor": ["Processor", "processor"],  # Infrastructure pattern
    "Handler": ["Handler", "handler"],  # Event handler pattern
    "Claim": ["citation-", "claim"],  # Citation Research BC has Claim as domain concept
    "HealthCheck": ["self-healing", "health_check", "HealthCheck"],  # Self-Healing BC
    "Service": ["ServiceWorker"],  # Browser API, not domain
    "Worker": ["ServiceWorker", "WorkerThread"],  # Infrastructure, not domain
    "Bot": ["Robot", "BotClient"],  # External API types, not domain
    "Process": ["process.", "ProcessEnv"],  # Node.js process API
}


def should_exclude_file(filepath: str) -> bool:
    """Check if a file should be excluded from scanning."""
    for excl in EXCLUDE_DIRS:
        if excl in filepath:
            return True
    for pattern in EXCLUDE_PATTERNS:
        if re.search(pattern, filepath):
            return True
    return False


def extract_banned_terms(specs_dir: Path) -> dict:
    """Extract all banned aliases from domain-terms.md files."""
    banned = {}

    for glossary in specs_dir.rglob("domain-terms.md"):
        content = glossary.read_text()
        bc_name = glossary.parent.name

        lines = content.split("\n")
        for i, line in enumerate(lines):
            stripped = line.strip()
            if re.match(r"^>?\*?\*?Aliases to AVOID:\*\*?$", stripped):
                for j in range(i + 1, min(i + 3, len(lines))):
                    aliases_line = lines[j].strip()
                    if aliases_line:
                        aliases_line = aliases_line.lstrip("> ").replace("**", "")
                        for alias in aliases_line.split(","):
                            alias = alias.strip()
                            if alias and not alias.startswith("["):
                                banned[alias] = {"bc": bc_name, "glossary": str(glossary)}
                        break

    return banned


def is_whitelisted_cross_bc(line: str, term: str, filepath: str) -> bool:
    """Check if a term is legitimately used in a different BC context."""
    if term in CROSS_BC_WHITELIST:
        for pattern in CROSS_BC_WHITELIST[term]:
            if pattern in line or pattern in filepath:
                return True
    return False


def is_real_violation(line: str, term: str, filepath: str) -> bool:
    """Determine if a line contains a real domain violation."""
    stripped = line.strip()

    # Skip comments (//, /*, *, --)
    if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*") or stripped.startswith("--"):
        return False

    # Skip SQL lines
    if stripped.startswith("CREATE ") or stripped.startswith("INSERT ") or stripped.startswith("ALTER "):
        return False

    # Skip import statements
    if stripped.startswith("import ") or stripped.startswith("require("):
        return False

    # Skip string literals (descriptions, error messages)
    if re.search(r"""['"`].*\b""" + re.escape(term) + r"""\b.*['"`]""", line):
        if not re.search(r"\b(class|interface|type|enum)\s+\w*" + re.escape(term), stripped):
            return False

    # Check cross-BC whitelist
    if is_whitelisted_cross_bc(line, term, filepath):
        return False

    # Skip type annotations that reference external types
    if "z." in stripped or "PropTypes" in stripped:
        return False

    # If it's a class/type definition with the term, it's a real violation
    if re.search(r"\b(class|interface|type|enum)\s+" + re.escape(term) + r"\b", stripped):
        return True

    # If it's a variable declaration with the exact term as type
    if re.search(r":\s*" + re.escape(term) + r"\b", stripped):
        return True

    return False


def scan_source(source_dir: Path, banned_terms: dict) -> list:
    """Scan source files for banned term usage with false-positive filtering."""
    violations = []

    for ts_file in source_dir.rglob("*.ts"):
        filepath = str(ts_file)

        if should_exclude_file(filepath):
            continue

        try:
            content = ts_file.read_text()
        except (UnicodeDecodeError, PermissionError):
            continue

        lines = content.split("\n")

        for line_no, line in enumerate(lines, 1):
            for term in banned_terms:
                pattern = r"\b" + re.escape(term) + r"\b"
                if re.search(pattern, line):
                    if is_real_violation(line, term, filepath):
                        violations.append({
                            "file": filepath,
                            "line": line_no,
                            "term": term,
                            "bc": banned_terms[term]["bc"],
                            "context": line.strip()[:100],
                            "severity": "HIGH" if re.search(r"\b(class|interface|type|enum)\s+" + re.escape(term), line) else "MEDIUM",
                        })

    return violations


def main():
    parser = argparse.ArgumentParser(description="Synonym drift monitor")
    parser.add_argument("--specs-dir", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, help="JSON output file")
    args = parser.parse_args()

    banned = extract_banned_terms(args.specs_dir)
    violations = scan_source(args.source_dir, banned)

    report = {
        "timestamp": os.popen("date -u +%Y-%m-%dT%H:%M:%SZ").read().strip(),
        "summary": {
            "banned_terms_checked": len(banned),
            "violations_found": len(violations),
            "unique_terms_violated": len(set(v["term"] for v in violations)),
            "unique_files_affected": len(set(v["file"] for v in violations)),
            "high_severity": len([v for v in violations if v.get("severity") == "HIGH"]),
        },
        "violations": violations,
        "by_bc": {},
        "by_term": {},
    }

    for v in violations:
        bc = v["bc"]
        if bc not in report["by_bc"]:
            report["by_bc"][bc] = []
        report["by_bc"][bc].append(v)

        term = v["term"]
        if term not in report["by_term"]:
            report["by_term"][term] = []
        report["by_term"][term].append(v)

    if args.output:
        args.output.write_text(json.dumps(report, indent=2))
        print(f"Report written to {args.output}")

    print(f"Terms checked: {report['summary']['banned_terms_checked']}")
    print(f"Violations: {report['summary']['violations_found']}")
    print(f"High severity: {report['summary']['high_severity']}")

    if violations:
        print("\nViolations by term:")
        for term, items in sorted(report["by_term"].items(), key=lambda x: -len(x[1])):
            print(f"  {term}: {len(items)}")

    return min(len(violations), 1)


if __name__ == "__main__":
    sys.exit(main())
