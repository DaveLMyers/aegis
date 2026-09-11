import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface FileBackup {
  path: string;
  existedBefore: boolean;
  previousContent: string | null;
}

/**
 * Tracks filesystem changes made during a stage so they can be reverted if
 * the stage ultimately fails past its retry/fallback budget. This is what
 * makes "rollback" a real, executable action rather than a described intent.
 */
export class ChangeTracker {
  private backups: FileBackup[] = [];

  constructor(private readonly projectRoot: string) {}

  writeFile(relativePath: string, content: string): void {
    const abs = resolve(this.projectRoot, relativePath);
    const existedBefore = existsSync(abs);
    this.backups.push({
      path: abs,
      existedBefore,
      previousContent: existedBefore ? readFileSync(abs, 'utf-8') : null,
    });
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  changedFiles(): string[] {
    return this.backups.map((b) => b.path);
  }

  rollback(): string[] {
    const reverted: string[] = [];
    for (const backup of [...this.backups].reverse()) {
      if (backup.existedBefore && backup.previousContent !== null) {
        writeFileSync(backup.path, backup.previousContent, 'utf-8');
      } else if (!backup.existedBefore && existsSync(backup.path)) {
        rmSync(backup.path);
      }
      reverted.push(backup.path);
    }
    this.backups = [];
    return reverted;
  }
}
