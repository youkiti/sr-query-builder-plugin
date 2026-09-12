/** @jest-environment node */
import { executeCase } from './run';
import { createEvalFetch } from './ncbiEval';
import type { BenchCase, GoldAudit, RunResult } from './types';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import type { JsonSchema } from '../../src/lib/llm/LLMProvider';

function assertSchema(value: unknown, schema: JsonSchema): void {
  if (schema.enum) expect(schema.enum).toContain(value);
  if (schema.type === 'string') expect(typeof value).toBe('string');
  else if (schema.type === 'array') {
    expect(Array.isArray(value)).toBe(true);
    for (const item of value as unknown[]) assertSchema(item, schema.items as JsonSchema);
  } else if (schema.type === 'object') {
    expect(value).not.toBeNull();
    expect(typeof value).toBe('object');
    const properties = schema.properties as Record<string, JsonSchema>;
    const object = value as Record<string, unknown>;
    for (const key of schema.required as string[]) expect(object).toHaveProperty(key);
    for (const key of Object.keys(object)) {
      expect(properties).toHaveProperty(key);
      assertSchema(object[key], properties[key]!);
    }
  } else throw new Error(`Unhandled schema: ${JSON.stringify(schema)}`);
}

test('real extraction, drafting and optimization evaluate an improving proposal without network', async () => {
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real network forbidden'));
  try {
    const purposes: string[] = [];
    const payloads: Record<string, unknown> = {
      extract_protocol: { framework_type: 'custom', research_question: 'Smoking cessation', inclusion_criteria: 'Smoking',
        exclusion_criteria: '', study_design: 'any', blocks: [{ block_label: 'Smoking', description: 'Smoking cessation' }], combination_expression: '#1' },
      draft_block: { concept_summary: 'Smoking', mesh_requirements: [], freeword_requirements: ['smoking'], rationale: '概念語を検索' },
      suggest_mesh: { suggestions: [] },
      expand_freeword: { freewords: [{ query: 'smoking[tiab]', rationale: '喫煙を検索' }] },
      optimize_query: { target_block_id: '1', proposed_expression: '(smoking[tiab] OR tobacco[tiab])', added_terms: ['tobacco[tiab]'],
        removed_terms: [], replaced_terms: [], rationale: '同義語で未捕捉シードを回収', measurement_ids: [], mesh_requests: [] },
    };
    const llmFactory: LlmProviderFactory = { model: 'fake', forPurpose: (purpose) => ({ model: 'fake', providerId: 'gemini',
      chat: async (_messages, options) => {
        purposes.push(purpose);
        expect(options?.responseFormat).toBe('json');
        expect(options?.responseSchema).toBeDefined();
        expect(payloads).toHaveProperty(purpose);
        const payload = payloads[purpose];
        assertSchema(payload, options!.responseSchema!);
        return { text: JSON.stringify(payload), tokensIn: 0, tokensOut: 0, raw: payload };
      },
    }) };
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://eutils.ncbi.nlm.nih.gov');
      const params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : url.searchParams;
      expect(params.get('db')).toBe('pubmed');
      if (url.pathname.endsWith('/esummary.fcgi')) {
        return new Response(JSON.stringify({ result: Object.fromEntries(['1', '2', '3'].map((id) => [id, { title: `Smoking study ${id}` }])) }));
      }
      expect(url.pathname).toBe('/entrez/eutils/esearch.fcgi');
      expect(params.get('maxdate')).toBe('2021/04/15');
      const term = params.get('term')!;
      calls.push(term);
      const ids = [...term.matchAll(/(\d+)\[(?:uid|pmid)\]/gi)].map((m) => m[1]!);
      if (term.includes(') NOT (')) {
        return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }));
      }
      const improved = term.includes('tobacco');
      const capture = ids.filter((id) => !term.includes('smoking') || improved || id === '1');
      return new Response(JSON.stringify({ esearchresult: { count: String(ids.length ? capture.length : improved ? 200 : 100),
        idlist: Number(params.get('retmax')) === 0 ? [] : capture } }));
    };
    const groups = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, members: [{ studyId: id, pmids: [String(i + 1)] }], pmids: [String(i + 1)] }));
    const fixture: BenchCase = { id: 'fake', pmcid: 'fake', searchDate: '2021-04-15', license: 'CC BY', protocolPath: 'protocol.md',
      gold: groups, heldOut: ['d'], seeds: { seed: 20260912, selections: groups.slice(0, 3).map((g) => ({ groupId: g.id, pmid: g.pmids[0]!, year: null })) } };
    const audit: GoldAudit = { includedStudyCount: 4, includedPmidCount: 4, overlapPmids: [], sharedPmids: [], withoutPmid: [], unmappedPmids: [],
      publicationYears: {}, exclusions: { withoutPmid: 0, unresolvedMapping: 0, outsideDate: null }, manual_review: false, reviewNote: '', dateValidation: 'pending' };
    const result: RunResult = { id: 'fake', runId: 'wiring', status: 'running', startedAt: '', model: 'fake', searchDate: fixture.searchDate,
      profileId: 'default', maxHits: 10000, maxIterations: 5, conditions: {}, apiCalls: { ncbi: 0, llm: 0 }, apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [] };
    const saved: RunResult[] = [];
    await executeCase(fixture, audit, 'Smoking cessation protocol', result, {
      eutils: { fetch: createEvalFetch(fixture.searchDate, fakeFetch, () => undefined), maxRetries: 0, strictCounts: true,
        rateLimiter: { acquire: async () => undefined } }, llmFactory, progress: () => undefined,
      save: () => saved.push(JSON.parse(JSON.stringify(result)) as RunResult),
    });
    expect(result.status).toBe('completed');
    expect(result.optimization?.status).toBe('achieved');
    expect(result.optimization!.iterations).toBeGreaterThanOrEqual(1);
    expect(result.optimization!.trials).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'proposal', accepted: true,
      after: expect.objectContaining({ totalHits: 200, capturedPmids: ['1', '2', '3'] }) })]));
    expect(result.conditions.C0).toMatchObject({ query: expect.stringContaining('smoking'), formula: expect.any(Object),
      measurement: { status: 'success', hits: 100 }, metrics: { heldOutRecall: 0 } });
    expect(result.conditions.C1).toMatchObject({ query: expect.stringContaining('tobacco'), formula: expect.any(Object),
      measurement: { status: 'success', hits: 200 }, metrics: { heldOutRecall: 1 } });
    expect(purposes).toEqual(Object.keys(payloads));
    expect(calls.some((term) => term.includes('tobacco'))).toBe(true);
    expect(saved).toHaveLength(3);
    expect(saved[0]!.denominator).toBeDefined();
    expect(saved[0]!.conditions.C0).toBeUndefined();
    expect(saved[1]!.conditions.C0).toBeDefined();
    expect(saved[1]!.conditions.C1).toBeUndefined();
    expect(saved[2]!.conditions.C1).toBeDefined();
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});
