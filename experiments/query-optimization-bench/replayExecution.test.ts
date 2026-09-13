/** @jest-environment node */
import { executeCase } from './run';
import { createReplayLlmFactory } from './replay';
import { installDomParser } from './domParser';
import { searchOutsideCandidates } from '../../src/app/services/expandService';
import type { BenchCase, GoldAudit, RunResult } from './types';
import type { LLMProvider } from '../../src/lib/llm/LLMProvider';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import type { EutilsDeps } from '../../src/lib/ncbi/eutils';

// held 経路は efetchArticles（DOMParser 依存）まで届くため、run.ts の main() と同様に補う。
installDomParser();

// このスイートは replay の「応答を使い切ったら次の LLM 呼び出しの直前で安全に止まる」経路を、
// runQueryOptimization を本物のまま executeCase 経由で確認する対象。confirmation（outside check）は
// wiring.test.ts と同じ理由でモックし、expand_recall/pick_boundary の LLM 文脈までは対象にしない。
jest.mock('../../src/app/services/expandService', () => ({
  searchOutsideCandidates: jest.fn().mockResolvedValue({ mode: 'margin', candidates: [], originalHits: 0, broadenedHits: 0,
    marginHits: 0, evaluatedCount: 0, additions: [], insideStrategy: null, specific: null }),
}));

const proposalResponse = (proposedExpression: string, rationale: string) => JSON.stringify({
  target_block_id: '1', proposed_expression: proposedExpression, added_terms: [], removed_terms: [],
  replaced_terms: [], rationale, measurement_ids: [], mesh_requests: [],
});

/**
 * 汎用の stub eutils。
 * - term に `[uid]` を含むクエリ（gold/シード捕捉判定）は要求された PMID を常に「全件捕捉」で返す。
 * - term に `) NOT (` を含むクエリ（採否判定の差集合・語別寄与の実測）は常に 0 件を返す
 *   （CLAUDE.md の注意どおり、既定件数を返すと候補がすべて保留になるため）。
 * - それ以外（ブロック行・最終式の件数）は式に含まれる round マーカーで件数を変え、
 *   ラウンドが進むほど目標件数（maxHits）に近づく「改善」を模す。
 */
function makeEutilsFetch(): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/esummary.fcgi')) {
      const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      return new Response(JSON.stringify({ result: Object.fromEntries(ids.map((id) => [id, { title: `Seed ${id}` }])) }));
    }
    const isPost = (init?.method ?? 'GET').toUpperCase() === 'POST';
    const params = isPost ? new URLSearchParams(String(init?.body ?? '')) : url.searchParams;
    const term = params.get('term') ?? '';
    const retmax = Number(params.get('retmax') ?? '20');
    if (term.includes('[uid]')) {
      const ids = [...term.matchAll(/(\d+)\[uid\]/g)].map((m) => m[1]!);
      return new Response(JSON.stringify({ esearchresult: { count: String(ids.length), idlist: ids } }));
    }
    if (term.includes(') NOT (')) {
      return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }));
    }
    const count = term.includes('round2') ? 2000 : term.includes('round1') ? 3000 : 5000;
    return new Response(JSON.stringify({ esearchresult: { count: String(count), idlist: retmax > 0 ? ['999'] : [] } }));
  }) as typeof fetch;
}

function makeFixtureAndAudit(): { fixture: BenchCase; audit: GoldAudit } {
  const groups = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, members: [{ studyId: id, pmids: [String(i + 1)] }], pmids: [String(i + 1)] }));
  const fixture: BenchCase = { id: 'fake', pmcid: 'fake', searchDate: '2021-04-15', license: 'CC BY', protocolPath: 'protocol.md',
    gold: groups, heldOut: ['d'], seeds: { seed: 20260912, selections: groups.slice(0, 3).map((g) => ({ groupId: g.id, pmid: g.pmids[0]!, year: null })) } };
  const audit: GoldAudit = { includedStudyCount: 4, includedPmidCount: 4, overlapPmids: [], sharedPmids: [], withoutPmid: [], unmappedPmids: [],
    publicationYears: {}, exclusions: { withoutPmid: 0, unresolvedMapping: 0, outsideDate: null }, manual_review: false, reviewNote: '', dateValidation: 'pending' };
  return { fixture, audit };
}

function makeFrozenC0(expression = 'seed[tiab]') {
  const formula = { blocks: [{ id: '1', expression, isCombination: false }], combinationExpression: null };
  const protocol = { frameworkType: 'custom' as const, researchQuestion: 'RQ', inclusionCriteria: 'include', exclusionCriteria: '',
    studyDesign: 'any', sourceType: 'markdown' as const, sourceFilename: 'protocol.md', rawTextRef: null, rawTextPreview: 'p', rawTextInline: 'p' };
  const blocks = { blocks: [{ blockLabel: 'Concept', description: 'd', aiGenerated: true as const, note: '' }], combinationExpression: '#1' };
  return { id: 'stub-c0', sha256: 'deadbeef', variant: 'criteria-only' as const, draftIndex: 1, protocol, blocks, formula };
}

/**
 * 削除提案が差集合検査に届いて保留になる経路を確認するための stub eutils。
 * 初期式 `(seed[tiab] OR extra[tiab])` から `extra[tiab]` を削る候補 `seed[tiab]` を想定し、
 * 採否判定の差集合クエリ（measureImpact が投げる 2 本）だけを厳密一致で特別扱いする:
 * - `(初期式) NOT (候補式)`（失う集合）には正の件数と書誌 2 件を返す
 * - `(候補式) NOT (初期式)`（増える集合）には 0 件を返す
 * それ以外の `) NOT (` を含むクエリ（語別寄与の実測など）は 0 件のまま。efetch にも応答する。
 */
function makeHeldEutilsFetch(): typeof fetch {
  const original = '(seed[tiab] OR extra[tiab])';
  const candidate = 'seed[tiab]';
  const lostQuery = `(${original}) NOT (${candidate})`;
  const gainedQuery = `(${candidate}) NOT (${original})`;
  return (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/esummary.fcgi')) {
      const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      return new Response(JSON.stringify({ result: Object.fromEntries(ids.map((id) => [id, { title: `Seed ${id}` }])) }));
    }
    if (url.pathname.endsWith('/efetch.fcgi')) {
      const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      const xml = `<PubmedArticleSet>${ids.map((id) => `<PubmedArticle><PMID>${id}</PMID><ArticleTitle>Lost ${id}</ArticleTitle>`
        + '<PubDate><Year>2020</Year></PubDate></PubmedArticle>').join('')}</PubmedArticleSet>`;
      return new Response(xml);
    }
    const isPost = (init?.method ?? 'GET').toUpperCase() === 'POST';
    const params = isPost ? new URLSearchParams(String(init?.body ?? '')) : url.searchParams;
    const term = params.get('term') ?? '';
    const retmax = Number(params.get('retmax') ?? '20');
    if (term.includes('[uid]')) {
      const ids = [...term.matchAll(/(\d+)\[uid\]/g)].map((m) => m[1]!);
      return new Response(JSON.stringify({ esearchresult: { count: String(ids.length), idlist: ids } }));
    }
    if (term === lostQuery) {
      return new Response(JSON.stringify({ esearchresult: { count: '150', idlist: ['901', '902'] } }));
    }
    if (term === gainedQuery) {
      return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }));
    }
    if (term.includes(') NOT (')) {
      return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }));
    }
    // 初期式（extra[tiab] を含む）は maxHits 超、候補式（extra[tiab] を削った seed[tiab] のみ）はそれより少ない。
    const count = term.includes('extra[tiab]') ? 5000 : 3000;
    return new Response(JSON.stringify({ esearchresult: { count: String(count), idlist: retmax > 0 ? ['999'] : [] } }));
  }) as typeof fetch;
}

function makeResult(): RunResult {
  return { id: 'fake', runId: 'fake-run', status: 'running', startedAt: '', model: 'fake', searchDate: '2021-04-15',
    profileId: 'default', maxHits: 1000, maxIterations: 5, conditions: {}, apiCalls: { ncbi: 0, llm: 0 },
    apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [] };
}

test('応答を使い切ると次の optimize_query 呼び出しの直前で止まり、run は失敗にならない', async () => {
  const { fixture, audit } = makeFixtureAndAudit();
  const frozenC0 = makeFrozenC0();
  const result = makeResult();

  const realCalls: string[] = [];
  const realFactory: LlmProviderFactory = {
    model: 'real-model',
    forPurpose: (purpose) => {
      realCalls.push(purpose);
      throw new Error(`予期しない purpose 呼び出し: ${purpose}`);
    },
  };
  const responses = [proposalResponse('(seed[tiab] OR round1[tiab])', 'stub round1'), proposalResponse('(seed[tiab] OR round1[tiab] OR round2[tiab])', 'stub round2')];
  const replayFactory = createReplayLlmFactory('stub-fixture', responses, realFactory,
    (provider: LLMProvider) => ({ model: provider.model, forPurpose: () => provider }));

  const eutils: EutilsDeps = { fetch: makeEutilsFetch(), maxRetries: 0, rateLimiter: { acquire: async () => undefined } };
  const saved: RunResult[] = [];
  await executeCase(fixture, audit, 'protocol text', result, {
    eutils, llmFactory: replayFactory, progress: () => undefined,
    save: () => saved.push(JSON.parse(JSON.stringify(result)) as RunResult), frozenC0,
    replay: { name: 'stub-fixture', sha256: 'fixture-hash', responseCount: responses.length, factory: replayFactory },
  });

  // optimize_query は応答数ちょうど 2 回分だけ記録され、3 回目は shouldStop が chat 呼び出し前に止める。
  expect(replayFactory.calls()).toBe(3);
  expect(replayFactory.used()).toBe(2);
  expect(replayFactory.exhausted()).toBe(true);
  // frozenC0 + confirmation のモックにより、replay 以外の purpose は一度も呼ばれない。
  expect(realCalls).toEqual([]);

  expect(result.optimization!.stopReason).toBe('user_stop');
  expect(result.optimization!.status).toBe('stopped');
  const proposals = result.optimization!.trials.filter((trial) => trial.kind === 'proposal');
  expect(proposals).toHaveLength(2);
  expect(proposals.every((trial) => trial.after !== null)).toBe(true);
  expect(proposals[1]!.after!.totalHits).toBe(2000);

  expect(result.replay).toEqual({ name: 'stub-fixture', sha256: 'fixture-hash', responseCount: 2, usedCount: 2, exhausted: true });
  expect(result.status).not.toBe('failed');
  expect(result.status).toBe('completed');
  expect(searchOutsideCandidates).toHaveBeenCalled();
});

test('削除候補が差集合検査に届いて保留になり、best は初期式のまま変わらない', async () => {
  const { fixture, audit } = makeFixtureAndAudit();
  const frozenC0 = makeFrozenC0('(seed[tiab] OR extra[tiab])');
  const result = { ...makeResult(), maxIterations: 1 };

  const realCalls: string[] = [];
  const realFactory: LlmProviderFactory = {
    model: 'real-model',
    forPurpose: (purpose) => {
      realCalls.push(purpose);
      throw new Error(`予期しない purpose 呼び出し: ${purpose}`);
    },
  };
  // removed_terms を明示するため proposalResponse ヘルパー（removed_terms 常に []）ではなく直接組み立てる。
  const removalResponse = JSON.stringify({ target_block_id: '1', proposed_expression: 'seed[tiab]',
    added_terms: [], removed_terms: ['extra[tiab]'], replaced_terms: [], rationale: '冗長語を削除', measurement_ids: [], mesh_requests: [] });
  const replayFactory = createReplayLlmFactory('stub-fixture-held', [removalResponse], realFactory,
    (provider: LLMProvider) => ({ model: provider.model, forPurpose: () => provider }));

  const eutils: EutilsDeps = { fetch: makeHeldEutilsFetch(), maxRetries: 0, rateLimiter: { acquire: async () => undefined } };
  await executeCase(fixture, audit, 'protocol text', result, {
    eutils, llmFactory: replayFactory, progress: () => undefined, save: () => undefined, frozenC0,
    replay: { name: 'stub-fixture-held', sha256: 'fixture-hash-held', responseCount: 1, factory: replayFactory },
  });

  expect(realCalls).toEqual([]);
  const proposals = result.optimization!.trials.filter((trial) => trial.kind === 'proposal');
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({ accepted: false, held: true,
    impact: { lostHits: 150, gainedHits: 0, error: null,
      inspected: [{ pmid: '901', title: 'Lost 901', year: 2020 }, { pmid: '902', title: 'Lost 902', year: 2020 }] } });
  // held のまま採用されないので、最良候補（fingerprint）は初期式のまま変わらない。
  expect(result.optimization!.best!.formula).toEqual(frozenC0.formula);
  expect(result.optimization!.best!.evaluation.fingerprint).toBe(result.optimization!.trials[0]!.after!.fingerprint);
  expect(result.status).not.toBe('failed');
});
