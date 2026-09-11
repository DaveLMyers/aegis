import type { GateResult, ProjectContextLike, StageExecutionResult, StageId } from './gateTypes.js';

export const alwaysOk = (): GateResult => ({ ok: true, reason: 'no preconditions' });

export function requireStagesPassed(stageIds: StageId[]) {
  return (ctx: ProjectContextLike): GateResult => {
    const missing = stageIds.filter((id) => !ctx.hasPassed(id));
    if (missing.length > 0) {
      return { ok: false, reason: `waiting on upstream stage(s) to pass: ${missing.join(', ')}` };
    }
    return { ok: true, reason: `all upstream stages passed: ${stageIds.join(', ')}` };
  };
}

export function requireOutputKeys(keys: string[]) {
  return (_ctx: ProjectContextLike, result: StageExecutionResult): GateResult => {
    const missing = keys.filter((k) => !(k in result.outputs));
    if (missing.length > 0) {
      return { ok: false, reason: `missing required output(s): ${missing.join(', ')}` };
    }
    return { ok: true, reason: `all required outputs present: ${keys.join(', ')}` };
  };
}

/** Checks a completed upstream stage's recorded output (from ProjectContext). */
export function requireStageOutputTrue(stageId: StageId, key: string) {
  return (ctx: ProjectContextLike): GateResult => {
    const record = ctx.latest(stageId);
    if (!record || record.outputs[key] !== true) {
      return { ok: false, reason: `${stageId}.${key} is not true` };
    }
    return { ok: true, reason: `${stageId}.${key} is true` };
  };
}

/** Checks the CURRENT stage's just-computed result (not yet recorded in ProjectContext). */
export function requireOutputTrue(key: string) {
  return (_ctx: ProjectContextLike, result: StageExecutionResult): GateResult => {
    if (result.outputs[key] !== true) {
      return { ok: false, reason: `${key} is not true` };
    }
    return { ok: true, reason: `${key} is true` };
  };
}

export function allOf(...gates: Array<(ctx: ProjectContextLike, result: StageExecutionResult) => GateResult>) {
  return (ctx: ProjectContextLike, result: StageExecutionResult): GateResult => {
    for (const gate of gates) {
      const outcome = gate(ctx, result);
      if (!outcome.ok) return outcome;
    }
    return { ok: true, reason: 'all conditions satisfied' };
  };
}
