import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function looksLikeRemote(value: string): boolean {
  return /^https?:\/\//.test(value) || /^git@/.test(value) || value.endsWith('.git');
}

/**
 * Resolves `--target-repo` into a local directory AEGIS can operate on. A
 * local path is used directly; a remote URL is shallow-cloned into a temp
 * directory. Both cases are treated identically by the caller -- that's the
 * point: AEGIS doesn't distinguish "a folder I was handed" from "a repo I
 * cloned," which is what makes it a real product operating on an external
 * codebase rather than a tool with one project baked into it.
 */
export function resolveTargetRepo(pathOrUrl: string, cwd: string): string {
  if (!looksLikeRemote(pathOrUrl)) {
    const abs = resolve(cwd, pathOrUrl);
    if (!existsSync(abs)) {
      throw new Error(`--target-repo path does not exist: ${abs}`);
    }
    return abs;
  }

  const dir = mkdtempSync(join(tmpdir(), 'aegis-target-'));
  const result = spawnSync('git', ['clone', '--depth', '1', pathOrUrl, dir], { encoding: 'utf-8' });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `failed to clone --target-repo "${pathOrUrl}": ${result.stderr || result.error?.message || 'unknown git error'}`,
    );
  }
  return dir;
}
