import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, FIXTURE_ALLOWED_WRITE_DIRS, EXTERNAL_TARGET_ALLOWED_WRITE_DIRS } from './runOrchestrator.js';
import { resolveTargetRepo } from './targetRepo.js';
import type { RunOptions, ScenarioDefinition, StageId } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The AEGIS repo itself -- always where scenario configs and run evidence live, regardless of what's being built. */
const aegisRoot = resolve(__dirname, '..', '..');

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx === -1) {
        flags.set(arg.slice(2), 'true');
      } else {
        flags.set(arg.slice(2, eqIdx), arg.slice(eqIdx + 1));
      }
    } else {
      positional.push(arg);
    }
  }
  const [command, scenarioName] = positional;
  return { command, scenarioName, flags };
}

function loadScenario(scenarioName: string | undefined, flags: Map<string, string>): ScenarioDefinition {
  const requirement = flags.get('requirement');
  if (requirement) {
    const name = flags.get('name');
    if (!name) {
      throw new Error('--requirement requires --name=<slug> (used to label the run and its evidence directory)');
    }
    return { name, type: 'adhoc', requirementText: requirement };
  }
  if (!scenarioName) {
    throw new Error('provide a scenario name (e.g. "greenfield") or --requirement="..." --name=<slug>');
  }
  const scenarioPath = resolve(aegisRoot, 'scenarios', `${scenarioName}.json`);
  return JSON.parse(readFileSync(scenarioPath, 'utf-8'));
}

async function main() {
  const { command, scenarioName, flags } = parseArgs(process.argv.slice(2));
  if (command !== 'run') {
    console.error(
      [
        'usage:',
        '  aegis run <scenario-name> [--auto-approve] [--inject-failure=<stageId>] [--inject-failure-severity=transient|hard]',
        '  aegis run --requirement="<text>" --name=<slug> [--auto-approve] [--target-repo=<path-or-url>]',
        '',
        'AGENT_MODE=llm (requires ANTHROPIC_API_KEY) uses the real Claude-backed agent instead of the',
        'deterministic playbooks -- required for --requirement/--target-repo runs, since the built-in',
        'playbooks are specific to the greenfield/brownfield/ambiguous URL-shortener scenarios.',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  let scenario: ScenarioDefinition;
  try {
    scenario = loadScenario(scenarioName, flags);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
    return;
  }

  const agentMode = (process.env.AGENT_MODE as 'deterministic' | 'llm' | undefined) ?? 'deterministic';
  const targetRepoArg = flags.get('target-repo');

  if (targetRepoArg && agentMode !== 'llm') {
    console.warn(
      '[warning] --target-repo with the deterministic agent will likely fail or do nothing useful -- ' +
        'the built-in playbooks write fixed, fixture-specific paths. Set AGENT_MODE=llm to actually ' +
        'have the agent reason about and write into an external target.',
    );
  }

  let targetProjectRoot = aegisRoot;
  let allowedWriteDirs = FIXTURE_ALLOWED_WRITE_DIRS;
  if (targetRepoArg) {
    try {
      targetProjectRoot = resolveTargetRepo(targetRepoArg, process.cwd());
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exitCode = 1;
      return;
    }
    allowedWriteDirs = EXTERNAL_TARGET_ALLOWED_WRITE_DIRS;
  }

  const options: RunOptions = {
    autoApprove: flags.has('auto-approve'),
    agentMode,
    injectFailureAt: flags.get('inject-failure') as StageId | undefined,
    injectFailureSeverity: (flags.get('inject-failure-severity') as 'transient' | 'hard' | undefined) ?? 'transient',
    maxRetries: 2,
    maxReplans: 2,
  };

  console.log(`\nAEGIS -- running scenario "${scenario.name}" (${scenario.type}), agentMode=${options.agentMode}`);
  if (targetRepoArg) {
    console.log(`  target: ${targetProjectRoot} (${targetRepoArg === targetProjectRoot ? 'local path' : `cloned from ${targetRepoArg}`})`);
  }
  if (options.injectFailureAt) {
    console.log(`  (demonstration failure injected at "${options.injectFailureAt}", severity=${options.injectFailureSeverity})`);
  }
  console.log('');

  const summary = await runScenario(scenario, options, aegisRoot, targetProjectRoot, allowedWriteDirs);

  console.log(
    `\nRun ${summary.status === 'completed' ? 'COMPLETED' : `HALTED${summary.haltedStage ? ` at "${summary.haltedStage}"` : ''}`}`,
  );
  console.log(`Evidence written to: ${summary.outputDir}`);
  if (summary.status === 'halted') process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
