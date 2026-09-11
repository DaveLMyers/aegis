/**
 * The fixed set of technologies AEGIS is allowed to reach for without
 * escalating. This models a real enterprise constraint the user raised
 * mid-build: an agentic engineering system shouldn't be free to pick
 * arbitrary tech per requirement -- it should check proposed choices against
 * an approved standards list, and only route to a human when a proposal
 * deviates from it.
 */
export const APPROVED_TECH_STACK = ['typescript', 'node.js', 'express', 'better-sqlite3', 'vitest'];

export interface TechStandardsCheck {
  compliant: boolean;
  nonCompliant: string[];
}

export function checkTechStandards(technologies: string[]): TechStandardsCheck {
  const approvedLower = new Set(APPROVED_TECH_STACK.map((t) => t.toLowerCase()));
  const nonCompliant = technologies.filter((t) => !approvedLower.has(t.toLowerCase()));
  return { compliant: nonCompliant.length === 0, nonCompliant };
}
