import { mkdirSync, rmSync } from 'node:fs';

for (const dir of ['src/target-project', 'tests/target-project', 'scenarios/runs']) {
  rmSync(dir, { recursive: true, force: true });
}
mkdirSync('scenarios/runs', { recursive: true });

console.log('Reset target-project, its tests, and prior scenario run evidence.');
console.log('Re-run scenarios in order to rebuild: greenfield, then brownfield, then ambiguous.');
