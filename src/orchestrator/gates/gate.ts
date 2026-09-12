import type { GateResult, ProjectContextLike, StageExecutionResult, StageId } from './gateTypes.js';
import type { Task } from '../types.js';

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

/**
 * Real structural validation of a task graph, not just "does the key exist"
 * -- this is what makes `decomposition` a genuine per-requirement work
 * breakdown rather than a schema-shaped placeholder. Checks: at least one
 * task, unique ids, every `dependsOn` reference resolves to a real task in
 * the same list, and no dependency cycle (a topological sort must succeed).
 */
export function requireValidTaskGraph() {
  return (_ctx: ProjectContextLike, result: StageExecutionResult): GateResult => {
    const tasks = result.outputs.tasks as Task[] | undefined;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { ok: false, reason: 'tasks must be a non-empty array' };
    }

    const ids = new Set<string>();
    for (const task of tasks) {
      if (ids.has(task.id)) {
        return { ok: false, reason: `duplicate task id "${task.id}"` };
      }
      ids.add(task.id);
    }

    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep)) {
          return { ok: false, reason: `task "${task.id}" depends on unknown task "${dep}"` };
        }
      }
    }

    // Kahn's algorithm: if every task can eventually be removed by repeatedly
    // taking one whose dependencies are all already satisfied, there is no
    // cycle. If tasks remain stuck at the end, the leftover ids ARE the cycle.
    const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn)]));
    const resolved = new Set<string>();
    let progressed = true;
    while (progressed && remaining.size > 0) {
      progressed = false;
      for (const [id, deps] of [...remaining.entries()]) {
        if ([...deps].every((d) => resolved.has(d))) {
          resolved.add(id);
          remaining.delete(id);
          progressed = true;
        }
      }
    }
    if (remaining.size > 0) {
      return { ok: false, reason: `dependency cycle detected among task(s): ${[...remaining.keys()].join(', ')}` };
    }

    return { ok: true, reason: `${tasks.length} task(s), a valid dependency graph` };
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
