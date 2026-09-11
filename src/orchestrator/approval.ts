import { createInterface } from 'node:readline/promises';

/**
 * Shared CLI human-approval prompt. Used both by the release-readiness gate
 * and by policy escalations (a policy check that can't be cleanly
 * allow/block, and needs a human to actually look) -- one prompt mechanism,
 * multiple call sites.
 */
export async function requestApproval(summary: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\n${summary}\nApprove? (y/N): `);
    return answer.trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}
