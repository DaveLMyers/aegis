import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'data', 'scenarios']);
const MAX_FILES = 300;

/**
 * A bounded file-tree listing of a target project root -- what
 * `ClaudeAgent` actually reasons against for "identify impacted modules"
 * (Core Requirement 3). Paths only, not content: enough for real
 * architectural awareness of an unfamiliar codebase without the prompt
 * blowing up on an arbitrarily large `--target-repo`.
 */
export function listProjectFiles(root: string, maxFiles = MAX_FILES): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    if (files.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (EXCLUDED_DIRS.has(entry) || entry.startsWith('.')) continue;
      const abs = join(dir, entry);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs);
      } else {
        files.push(relative(root, abs));
      }
    }
  }

  walk(root);
  return files.sort();
}
