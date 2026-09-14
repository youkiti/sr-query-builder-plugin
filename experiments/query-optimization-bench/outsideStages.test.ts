/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import * as expand from '../../src/app/services/expandService';
import { sharedEutilsRateLimiters } from '../../src/lib/ncbi/eutils';
import { hashC0Content, type C0Artifact } from './c0Artifact';
import { hashMarginContent, type MarginContent } from './freezeMargin';
import * as gitInfo from './gitInfo';
import { classifyStudy, decideOutsideExisting, main, outsideResultDir, parseOutsideStagesArgs, STAGE_NAMES, type OutsideRun } from './outsideStages';
import type { BenchCase, FrozenSeeds } from './types';

jest.mock('dotenv', () => ({ config: jest.fn() }));
const caseId = 'r3-vascular-bleeding';
const name = 'criteria-only-draft1-margin1';
const args = ['--case', caseId, '--margin', name];
const marginQuery = '((base[tiab]) OR outside[tiab]) NOT (base[tiab])';
const stages: expand.OutsideSearchStages = { broadenedQuery: '(base[tiab]) OR outside[tiab]', marginQuery,
  retrievedPmids: ['3', '4', '5', '6', '7'], novelPmids: ['4', '5', '6', '7'],
  requestedPmids: ['5', '6', '7'], fetchedPmids: ['6', '7'], pickedPmids: ['7'] };
const oldGemini = process.env.GEMINI_API_KEY;
const oldNcbi = process.env.NCBI_API_KEY;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'outside-stages-'));
  const results = join(root, 'results');
  const dir = join(root, caseId);
  mkdirSync(join(dir, 'c0'), { recursive: true });
  mkdirSync(join(dir, 'margin'));
  const original = JSON.parse(readFileSync(join(__dirname, 'fixtures', caseId, 'c0', 'criteria-only-draft1.json'), 'utf8')) as C0Artifact;
  const { sha256, ...content } = original;
  expect(hashC0Content(content)).toBe(sha256);
  content.formula = { blocks: [{ id: '1', expression: 'base[tiab]', isCombination: false }], combinationExpression: null };
  content.protocol = { ...content.protocol, researchQuestion: '研究課題', inclusionCriteria: '組入', exclusionCriteria: '除外' };
  const c0 = { ...content, sha256: hashC0Content(content) };
  const c0Path = join(dir, 'c0', 'criteria-only-draft1.json');
  writeFileSync(c0Path, JSON.stringify(c0));
  const margin: MarginContent = { schemaVersion: 1, name, caseId, c0: { name: 'criteria-only-draft1', sha256: c0.sha256 },
    additions: [{ blockId: '1', additions: [{ term: 'outside[tiab]', axis: 'freeword', rationale: '別名' }] }],
    broadenedQuery: stages.broadenedQuery!, marginQuery, originalHits: 10, marginHits: 6, searchDate: '2022-03-31',
    model: 'fake', createdAt: '2026-09-14T00:00:00Z', gitCommit: 'frozen', gitDirty: false };
  const marginPath = join(dir, 'margin', `${name}.json`);
  const saveMargin = () => writeFileSync(marginPath, JSON.stringify({ ...margin, sha256: hashMarginContent(margin) }));
  saveMargin();
  const seeds: FrozenSeeds = { seed: 20260912, selections: ['100', '101', '102'].map((pmid) => ({ groupId: pmid, pmid, year: null })) };
  const gold = ['100', '101', '102', '8', '1', '2', '4', '5', '6', '7'].map((pmid) => ({ id: pmid, pmids: [pmid], members: [{ studyId: `研究${pmid}`, pmids: [pmid] }] }));
  const fixture: BenchCase = { id: caseId, pmcid: 'fake', searchDate: margin.searchDate, license: 'CC BY', protocolPath: 'unused',
    gold, heldOut: [], seeds };
  writeFileSync(join(dir, 'case.json'), JSON.stringify(fixture));
  writeFileSync(join(dir, 'seeds.json'), JSON.stringify(seeds));
  return { root, dir, results, c0, c0Path, margin, marginPath, saveMargin, fixture, seeds };
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'fake-gemini-secret';
  process.env.NCBI_API_KEY = 'fake-ncbi-secret';
  jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire').mockResolvedValue(undefined);
  jest.spyOn(gitInfo, 'getGitCommit').mockReturnValue('same-commit');
  jest.spyOn(gitInfo, 'isGitDirty').mockReturnValue(false);
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  if (oldGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGemini;
  if (oldNcbi === undefined) delete process.env.NCBI_API_KEY; else process.env.NCBI_API_KEY = oldNcbi;
});

test('引数の既定値、上限、未知・重複・不正な値を検証する', () => {
  expect(parseOutsideStagesArgs(args)).toEqual({ caseId, marginName: name, seed: 20260912, retmax: 50,
    candidateLimit: 20, sort: undefined, rankDepth: 10000, label: undefined, dryRun: false });
  expect(parseOutsideStagesArgs([...args, '--seeds', 'named', '--retmax', '10000', '--candidate-limit', '30',
    '--sort', 'relevance', '--rank-depth', '0', '--label', 'a.B_1-2', '--dry-run']))
    .toMatchObject({ seed: 'named', retmax: 10000, candidateLimit: 30, sort: 'relevance', rankDepth: 0, dryRun: true });
  for (const pair of [['--retmax', '0'], ['--retmax', '10001'], ['--retmax', '1.5'], ['--candidate-limit', '0'],
    ['--candidate-limit', 'NaN'], ['--rank-depth', '-1'], ['--rank-depth', '10001'], ['--sort', 'date'],
    ['--seeds', 'Bad'], ['--label', '../escape'], ['--label', 'replay-test'], ['--unknown'], ['--retmax']]) {
    expect(() => parseOutsideStagesArgs([...args, ...pair])).toThrow();
  }
  for (const invalid of [[], ['--case', 'unknown', '--margin', name], ['--case', caseId, '--margin', '../escape'],
    ['--case', caseId, '--margin', 'a'.repeat(65)], [...args, '--margin', name]]) expect(() => parseOutsideStagesArgs(invalid)).toThrow();
});

test('到達可能な段階配列で 8 判定と 1 始まり順位を区別する', () => {
  // 既知集合が 3、取得上限で 2、書誌取得上限で 4 が落ちた単一の探索を表す。
  const validStages = { ...stages, novelPmids: ['4', '5', '6', '7'], requestedPmids: ['4', '5', '6'],
    fetchedPmids: ['5', '6'], pickedPmids: ['6'] };
  const outcomes = ['8', '1', '2', '3', '7', '4', '5', '6'].map((pmid) =>
    classifyStudy({ studyId: pmid, pmids: [pmid] }, ['8'], ['2', '3', '4', '5', '6', '7'], validStages, ['2', '3', '4', '5', '6', '7']));
  expect(outcomes.map((item) => item.stage)).toEqual(STAGE_NAMES);
  expect(outcomes[0]).toMatchObject({ retrievedRank: null, deepRank: null });
  expect(outcomes[1]).toMatchObject({ retrievedRank: null, deepRank: null });
  expect(outcomes[2]).toMatchObject({ retrievedRank: null, deepRank: 1 });
  expect(outcomes[3]).toMatchObject({ retrievedRank: 1, deepRank: 2 });
  expect(classifyStudy({ studyId: '複数報告', pmids: ['1', '6', '5'] }, [], ['5', '6'], validStages, null))
    .toMatchObject({ stage: 'presented', retrievedRank: 3, deepRank: null });
  expect(classifyStudy({ studyId: '現式で捕捉済みの複数報告', pmids: ['8', '6', '5'] }, ['8'], ['5', '6'], validStages, null))
    .toMatchObject({ stage: 'captured_by_current', retrievedRank: 3, deepRank: null });
});

test('dry-run は artifact・C0 を照合するだけで .env・通信・書き込みなし', async () => {
  const fixture = setup();
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実通信禁止'));
  await main([...args, '--dry-run'], fixture.root, fixture.results);
  expect(network).not.toHaveBeenCalled();
  expect(config).not.toHaveBeenCalled();
  expect(existsSync(fixture.results)).toBe(false);
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining(outsideResultDir(fixture.results, parseOutsideStagesArgs(args))));
});

test('fixture 不在を指定の日本語メッセージで拒否する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'missing-margin-'));
  await expect(main([...args, '--dry-run'], root)).rejects.toThrow(`margin fixture が見つかりません: ${join(root, caseId, 'margin', `${name}.json`)}`);
});

test.each(['margin', 'c0', 'reference', 'split', 'date'])('dry-run でもハッシュ・分割・検索日の不一致を拒否する: %s', async (kind) => {
  const fixture = setup();
  if (kind === 'margin') writeFileSync(fixture.marginPath, JSON.stringify({ ...fixture.margin, sha256: 'bad' }));
  if (kind === 'c0') writeFileSync(fixture.c0Path, JSON.stringify({ ...fixture.c0, sha256: 'bad' }));
  if (kind === 'reference') { fixture.margin.c0.sha256 = 'bad'; fixture.saveMargin(); }
  if (kind === 'date') { fixture.margin.searchDate = '2020-01-01'; fixture.saveMargin(); }
  if (kind === 'split') {
    const { sha256: previousHash, ...content } = fixture.c0;
    expect(hashC0Content(content)).toBe(previousHash);
    content.seedSplit = 's42';
    const sha256 = hashC0Content(content);
    writeFileSync(fixture.c0Path, JSON.stringify({ ...content, sha256 }));
    fixture.margin.c0.sha256 = sha256;
    fixture.saveMargin();
  }
  await expect(main([...args, '--dry-run'], fixture.root, fixture.results)).rejects.toThrow('一致しません');
});

function fakeNetwork() {
  const events: { kind: string; params: URLSearchParams; body: string }[] = [];
  const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const body = String(init?.body ?? '');
    const params = init?.method === 'POST' ? new URLSearchParams(body) : url.searchParams;
    if (url.hostname === 'generativelanguage.googleapis.com') {
      events.push({ kind: 'llm', params, body });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ picks: [
        { pmid: '7', reason: 'fake-gemini-secret fake-ncbi-secret' },
      ] }) }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 } }));
    }
    if (url.pathname.endsWith('/efetch.fcgi')) {
      events.push({ kind: 'efetch', params, body });
      return new Response('<PubmedArticleSet>' + ['7', '6'].map((pmid) => `<PubmedArticle><MedlineCitation><PMID>${pmid}</PMID><Article><ArticleTitle>論文${pmid}</ArticleTitle></Article></MedlineCitation></PubmedArticle>`).join('') + '</PubmedArticleSet>');
    }
    if (url.pathname.endsWith('/esearch.fcgi')) {
      events.push({ kind: 'esearch', params, body });
      const term = params.get('term') ?? '';
      let pmids: string[];
      if (term.includes('[uid]')) {
        if (!events.some((event) => event.kind === 'llm')) throw new Error('選定終了前に gold を渡しています');
        pmids = [...term.matchAll(/(\d+)\[uid\]/g)].map((match) => match[1]!);
        if (term.startsWith(`(${marginQuery}) AND (`)) pmids = pmids.filter((pmid) => !['1', '8'].includes(pmid));
        else if (term.startsWith('(base[tiab]) AND (')) pmids = pmids.filter((pmid) => pmid === '8');
      } else if (term === marginQuery) pmids = ['100', '5', '6', '7', '4', '2'];
      else if (term === 'base[tiab]') pmids = ['100', '101', '102'];
      else throw new Error('想定外の式');
      return new Response(JSON.stringify({ esearchresult: { count: String(pmids.length), idlist: pmids.slice(0, Number(params.get('retmax'))) } }));
    }
    throw new Error('想定外の通信');
  });
  return { network, events };
}

test.each([0, 10])('実サービスとフェイク通信で段階測定・事後照合・観測・redact を保存する（rankDepth=%i）', async (depth) => {
  const fixture = setup();
  const { events } = fakeNetwork();
  const outside = jest.spyOn(expand, 'searchOutsideCandidates');
  const runArgs = [...args, '--retmax', '5', '--candidate-limit', '3', '--rank-depth', String(depth), '--sort', 'relevance'];
  await main(runArgs, fixture.root, fixture.results);
  const dir = outsideResultDir(fixture.results, parseOutsideStagesArgs(runArgs));
  const saved = readFileSync(join(dir, 'run.json'), 'utf8');
  const result = JSON.parse(saved) as OutsideRun;
  expect(result.status).toBe('completed');
  expect([...outside.mock.calls[0]![0].existingPmids]).toEqual(['100', '101', '102']);
  expect(outside.mock.calls[0]![0]).toMatchObject({ researchQuestion: '研究課題', inclusionCriteria: '組入', exclusionCriteria: '除外', additions: fixture.margin.additions });
  expect(result.stages).toMatchObject({ retrievedPmids: ['100', '5', '6', '7', '4'], novelPmids: ['5', '6', '7', '4'],
    requestedPmids: ['5', '6', '7'], fetchedPmids: ['6', '7'], pickedPmids: ['7'] });
  expect(result.heldOutStages.map((study) => study.stage)).toEqual(['captured_by_current', 'not_in_margin', 'beyond_retmax', 'beyond_candidate_limit', 'efetch_missing', 'not_picked', 'presented']);
  expect(result.missedHeldOutCount).toBe(6);
  expect(result.stageCounts).toEqual({ captured_by_current: 1, not_in_margin: 1, beyond_retmax: 1, excluded_as_known: 0,
    beyond_candidate_limit: 1, efetch_missing: 1, not_picked: 1, presented: 1 });
  expect(result.heldOutStages.find((study) => study.studyId === '研究2')).toMatchObject({ retrievedRank: null, deepRank: depth ? 6 : null });
  expect(result.heldOutStages.find((study) => study.studyId === '研究7')).toMatchObject({ retrievedRank: 4, deepRank: depth ? 4 : null });
  expect(result.deepRankPurpose).toContain('事後集計専用');
  expect(result.apiCalls).toEqual({ ncbi: depth ? 7 : 6, llm: 1 });
  const matching = events.filter((event) => event.kind === 'esearch' && event.params.get('term')?.includes('[uid]')
    && event.params.get('term')?.includes(' AND '));
  expect(matching.map((event) => event.params.get('term'))).toEqual([
    '(base[tiab]) AND (8[uid] OR 1[uid] OR 2[uid] OR 4[uid] OR 5[uid] OR 6[uid] OR 7[uid])',
    `(${marginQuery}) AND (8[uid] OR 1[uid] OR 2[uid] OR 4[uid] OR 5[uid] OR 6[uid] OR 7[uid])`,
  ]);
  expect(result.llmUsage).toMatchObject({ calls: 1, tokensIn: 5, tokensOut: 7 });
  expect(result.llmLogs).toEqual(['llm/0001_pick_boundary.json']);
  expect(events.find((event) => event.kind === 'llm')!.body).not.toContain('研究1');
  for (const event of events.filter((event) => event.kind === 'esearch')) {
    expect(event.params.get('maxdate')).toBe('2022/03/31');
    expect(event.params.get('sort')).toBe(event.params.get('term') === marginQuery ? 'relevance' : null);
  }
  const progress = readFileSync(join(dir, result.runId, 'progress.jsonl'), 'utf8');
  expect(progress).toContain('limiter');
  expect(progress).toContain('startedAt');
  expect(progress).toContain('事後集計');
  const log = readFileSync(join(dir, result.runId, result.llmLogs[0]!), 'utf8');
  for (const text of [saved, progress, log]) {
    expect(text).not.toContain('fake-gemini-secret');
    expect(text).not.toContain('fake-ncbi-secret');
  }
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('判定別研究数'));
  expect(process.stdout.write).toHaveBeenCalledWith('取りこぼし（現式で未捕捉）: 6 研究\n');
});

test('凍結クエリ不一致は failed にし別の式の段階結果や gold 通信を残さない', async () => {
  const fixture = setup();
  fixture.margin.marginQuery = 'different[tiab]';
  fixture.saveMargin();
  const { events } = fakeNetwork();
  await expect(main(args, fixture.root, fixture.results)).rejects.toThrow('クエリが一致しません');
  const result = JSON.parse(readFileSync(join(outsideResultDir(fixture.results, parseOutsideStagesArgs(args)), 'run.json'), 'utf8')) as OutsideRun;
  expect(result).toMatchObject({ status: 'failed', stages: null, candidates: [], heldOutStages: [] });
  expect(events.some((event) => event.params.get('term')?.includes('[uid]'))).toBe(false);
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('対象研究 0 件'));
});

test('完了結果は同一コミットならスキップし別コミットなら --label を促す。失敗は再試行する', async () => {
  expect(decideOutsideExisting({ status: 'failed', gitCommit: 'other' }, 'same')).toBe('run');
  const fixture = setup();
  const dir = outsideResultDir(fixture.results, parseOutsideStagesArgs(args));
  mkdirSync(dir, { recursive: true });
  const saved = JSON.stringify({ status: 'completed', gitCommit: 'same-commit' });
  writeFileSync(join(dir, 'run.json'), saved);
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実通信禁止'));
  await main(args, fixture.root, fixture.results);
  await main([...args, '--dry-run'], fixture.root, fixture.results);
  expect(config).not.toHaveBeenCalled();
  jest.mocked(gitInfo.getGitCommit).mockReturnValue('different');
  await expect(main(args, fixture.root, fixture.results)).rejects.toThrow('--label');
  await expect(main([...args, '--dry-run'], fixture.root, fixture.results)).rejects.toThrow('--label');
  expect(network).not.toHaveBeenCalled();
  expect(readFileSync(join(dir, 'run.json'), 'utf8')).toBe(saved);
  expect(readdirSync(dir)).toEqual(['run.json']);
});
