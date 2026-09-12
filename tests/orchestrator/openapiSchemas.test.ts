import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import {
  OPENAPI_YAML,
  OPENAPI_YAML_TIERED,
  OPENAPI_YAML_TIERED_ANALYTICS,
} from '../../src/orchestrator/agents/playbooks/targetProjectTemplates.js';

interface OpenApiDoc {
  openapi: string;
  paths: Record<string, unknown>;
}

/**
 * Core Requirement 5 asks for real API/schema definitions, not just prose --
 * these tests prove the generated OpenAPI documents are actually valid YAML
 * with the shape a schema-consuming tool would expect, not just plausible-
 * looking template strings that happen to render.
 */
describe('generated OpenAPI schemas', () => {
  it.each([
    ['greenfield', OPENAPI_YAML, ['/health', '/links', '/{code}', '/{code}/stats']],
    ['brownfield', OPENAPI_YAML_TIERED, ['/health', '/links', '/{code}', '/{code}/stats']],
    ['ambiguous', OPENAPI_YAML_TIERED_ANALYTICS, ['/health', '/links', '/{code}', '/{code}/stats']],
  ])('%s: parses as valid YAML with an OpenAPI 3.x version and every real endpoint', (_name, yaml, expectedPaths) => {
    const doc = load(yaml) as OpenApiDoc;
    expect(doc.openapi).toMatch(/^3\./);
    for (const path of expectedPaths) {
      expect(doc.paths).toHaveProperty(path);
    }
  });

  it('brownfield and ambiguous schemas add clientTier to the create-link request body', () => {
    for (const yaml of [OPENAPI_YAML_TIERED, OPENAPI_YAML_TIERED_ANALYTICS]) {
      const doc = load(yaml) as any;
      const createSchema = doc.paths['/links'].post.requestBody.content['application/json'].schema;
      expect(createSchema.properties).toHaveProperty('clientTier');
    }
  });

  it('only the ambiguous schema documents referrerBreakdown on stats', () => {
    const greenfield = load(OPENAPI_YAML) as any;
    const tiered = load(OPENAPI_YAML_TIERED) as any;
    const ambiguous = load(OPENAPI_YAML_TIERED_ANALYTICS) as any;

    const statsSchema = (doc: any) => doc.paths['/{code}/stats'].get.responses['200'].content?.['application/json']?.schema;

    expect(statsSchema(greenfield)?.properties ?? {}).not.toHaveProperty('referrerBreakdown');
    expect(statsSchema(tiered)?.properties ?? {}).not.toHaveProperty('referrerBreakdown');
    expect(statsSchema(ambiguous).properties).toHaveProperty('referrerBreakdown');
  });
});
