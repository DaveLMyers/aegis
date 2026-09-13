import { createInterface, type Interface } from 'node:readline/promises';

/**
 * Shared CLI human-approval prompt. Used by decomposition-plan approval,
 * policy escalations, and the release-readiness gate -- one prompt
 * mechanism, multiple call sites, and as of the second human checkpoint a
 * single run can legitimately hit this more than once.
 *
 * Deliberately a single reused interface for the whole process, NOT a fresh
 * createInterface()/close() per call: closing a readline.Interface bound to
 * process.stdin leaves stdin in a state a newly-created interface cannot
 * reliably resume reading from -- verified hands-on (a second sequential
 * question() call hung indefinitely, confirmed via a standalone repro, not
 * assumed). Caller must call closeApprovalInterface() once the run is fully
 * done, or an approval-requesting run would otherwise hang open on stdin
 * forever after its last prompt.
 */
let sharedInterface: Interface | undefined;

export async function requestApproval(summary: string): Promise<boolean> {
  if (!sharedInterface) {
    sharedInterface = createInterface({ input: process.stdin, output: process.stdout });
  }
  const answer = await sharedInterface.question(`\n${summary}\nApprove? (y/N): `);
  return answer.trim().toLowerCase().startsWith('y');
}

export function closeApprovalInterface(): void {
  sharedInterface?.close();
  sharedInterface = undefined;
}
