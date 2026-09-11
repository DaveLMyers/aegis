import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from './runOrchestrator.js';
import type { RunOptions, ScenarioDefinition, StageId } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

function parseArgs(argv: string[]) {
  const [command, scenarioName, ...rest] = argv;
  const flags = new Map<string, string>();
  for (const arg of rest) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    flags.set(key, value ?? 'true');
  }
  return { command, scenarioName, flags };
}

async function main() {
  const { command, scenarioName, flags } = parseArgs(process.argv.slice(2));
  if (command !== 'run' || !scenarioName) {
    console.error(
      'usage: aegis run <scenario-name> [--auto-approve] [--inject-failure=<stageId>] [--inject-failure-severity=transient|hard]',
    );
    process.exitCode = 1;
    return;
  }

  const scenarioPath = resolve(projectRoot, 'scenarios', `${scenarioName}.json`);
  const scenario: ScenarioDefinition = JSON.parse(readFileSync(scenarioPath, 'utf-8'));

  const options: RunOptions = {
    autoApprove: flags.has('auto-approve'),
    agentMode: (process.env.AGENT_MODE as 'deterministic' | 'llm' | undefined) ?? 'deterministic',
    injectFailureAt: flags.get('inject-failure') as StageId | undefined,
    injectFailureSeverity: (flags.get('inject-failure-severity') as 'transient' | 'hard' | undefined) ?? 'transient',
    maxRetries: 2,
    maxReplans: 2,
  };

  console.log(`\nAEGIS -- running scenario "${scenarioName}" (${scenario.type}), agentMode=${options.agentMode}`);
  if (options.injectFailureAt) {
    console.log(`  (demonstration failure injected at "${options.injectFailureAt}", severity=${options.injectFailureSeverity})`);
  }
  console.log('');

  const summary = await runScenario(scenario, options, projectRoot);

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
