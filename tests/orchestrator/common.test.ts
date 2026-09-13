import { describe, expect, it } from 'vitest';
import { stripAnsi, withDecompositionApproval } from '../../src/orchestrator/agents/playbooks/common.js';
import type { StageExecutionOptions } from '../../src/orchestrator/agents/agent.js';

describe('stripAnsi', () => {
  it('removes ANSI color codes while preserving the actual text', () => {
    // The exact shape vitest's colored failure output takes -- caught via
    // hands-on testing: this was leaking straight into report.md unstripped.
    const raw = '\x1b[32m- Expected:\x1b[39m \n"standard"\n\n\x1b[31m+ Received:\x1b[39m \nundefined';
    const cleaned = stripAnsi(raw);

    expect(cleaned).not.toContain('\x1b[');
    expect(cleaned).toContain('- Expected:');
    expect(cleaned).toContain('"standard"');
    expect(cleaned).toContain('+ Received:');
    expect(cleaned).toContain('undefined');
  });

  it('leaves plain text with no escape codes untouched', () => {
    expect(stripAnsi('all tests passed')).toBe('all tests passed');
  });

  it('handles multiple and adjacent escape codes', () => {
    const raw = '\x1b[90m \x1b[2m❯\x1b[22m\x1b[39m tests/foo.test.ts\x1b[2m:\x1b[22m21:39';
    expect(stripAnsi(raw)).toBe(' ❯ tests/foo.test.ts:21:39');
  });
});

describe('withDecompositionApproval', () => {
  const io = { tracker: {} as any, simulateFailure: false, fallback: false, autoApprove: true } as StageExecutionOptions;
  const base = { outputs: { tasks: [{ id: 't1', description: 'do a thing' }] }, rationale: 'derived one task' };

  it('auto-approves under --auto-approve and records that explicitly, rather than silently implying it', async () => {
    const result = await withDecompositionApproval(base, io);
    expect(result.outputs.approved).toBe(true);
    expect(result.rationale).toContain('auto-approved');
    // Original outputs/rationale are preserved, not replaced.
    expect(result.outputs.tasks).toBe(base.outputs.tasks);
    expect(result.rationale).toContain('derived one task');
  });
});
