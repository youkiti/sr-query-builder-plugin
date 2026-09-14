/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { buildBroadenedFormula, buildMarginQuery, type RecallAdditionItem } from '../../src/features/formula/recallExpansion';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { sharedEutilsRateLimiters } from '../../src/lib/ncbi/eutils';
import { hashC0Content, loadC0Artifact, type C0Artifact } from './c0Artifact';
import { hashMarginContent, loadMarginArtifact, type MarginContent } from './freezeMargin';
import { main, mergeAdditions, parseMergeMarginsArgs } from './mergeMargins';

jest.mock('dotenv', () => ({ config: jest.fn() }));
const caseId = 'r3-vascular-bleeding';
const args = ['--case', caseId, '--margins', 'first,second', '--name', 'merged'];
const oldNcbi = process.env.NCBI_API_KEY;
const oldGemini = process.env.GEMINI_API_KEY;
const term = (value: string, rationale = '先の理由'): RecallAdditionItem => ({ term: value, axis: 'freeword', rationale });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'merge-margins-'));
  const dir = join(root, caseId);
  mkdirSync(join(dir, 'c0'), { recursive: true });
  mkdirSync(join(dir, 'margin'));
  const original = JSON.parse(readFileSync(join(__dirname, 'fixtures', caseId, 'c0', 'criteria-only-draft1.json'), 'utf8')) as C0Artifact;
  const { sha256, ...content } = original;
  expect(hashC0Content(content)).toBe(sha256);
  content.formula = { blocks: [{ id: '1', expression: 'base[tiab]', isCombination: false },
    { id: '2', expression: 'other[tiab]', isCombination: false }], combinationExpression: '#1 AND #2' };
  const c0 = { ...content, sha256: hashC0Content(content) };
  writeFileSync(join(dir, 'c0', 'criteria-only-draft1.json'), JSON.stringify(c0));
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ id: caseId, searchDate: '2022-03-31' }));
  const first: MarginContent = { schemaVersion: 1, name: 'first', caseId,
    c0: { name: 'criteria-only-draft1', sha256: c0.sha256 },
    additions: [{ blockId: '1', additions: [term(' shared[tiab] '), term('first[tiab]')] }],
    broadenedQuery: 'unused', marginQuery: 'unused', originalHits: 1, marginHits: 2,
    searchDate: '2022-03-31', model: 'fake', createdAt: '2026-01-01', gitCommit: null, gitDirty: false };
  const second: MarginContent = { ...first, name: 'second', additions: [
    { blockId: '2', additions: [term('shared[tiab]')] },
    { blockId: '1', additions: [term('shared[tiab]', '後の理由'), term('Shared[tiab]'), term('second[tiab]')] },
  ] };
  function save(margin: MarginContent) {
    writeFileSync(join(dir, 'margin', `${margin.name}.json`), JSON.stringify({ ...margin, sha256: hashMarginContent(margin) }));
  }
  save(first);
  save(second);
  return { root, dir, first, second, save, out: join(dir, 'margin', 'merged.json') };
}

beforeEach(() => {
  process.env.NCBI_API_KEY = 'fake-ncbi-secret';
  process.env.GEMINI_API_KEY = 'fake-gemini-secret';
  jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire').mockResolvedValue(undefined);
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実通信禁止'));
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  if (oldNcbi === undefined) delete process.env.NCBI_API_KEY; else process.env.NCBI_API_KEY = oldNcbi;
  if (oldGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGemini;
});

test('必須・未知・重複・不正な引数を拒否する', () => {
  expect(parseMergeMarginsArgs(args)).toEqual({ caseId, margins: ['first', 'second'], name: 'merged', dryRun: false });
  for (const invalid of [[], ['--case', 'unknown', ...args.slice(2)], args.slice(0, 4),
    ['--case', caseId, '--name', 'merged'], [...args, '--unknown'], [...args, '--case', caseId],
    [...args, '--margins', 'a,b'], [...args, '--name', 'other'], [...args, '--dry-run', '--dry-run'],
    [...args, '--dry-run', 'true'], [...args.slice(0, 4), '--name'],
    ...['first', 'first,first', 'first,', '../bad,second', 'First,second', `${'a'.repeat(65)},second`]
      .map((value) => ['--case', caseId, '--margins', value, '--name', 'merged']),
    ...['../bad', 'A', '', 'a'.repeat(65)].map((value) => [...args.slice(0, 4), '--name', value])]) {
    expect(() => parseMergeMarginsArgs(invalid)).toThrow();
  }
});

test('語は空白を除いて重複排除し、属性とブロック・語の初出順を保持する', () => {
  const { first, second } = setup();
  expect(mergeAdditions([first, second])).toEqual([
    { blockId: '1', additions: [term('shared[tiab]'), term('first[tiab]'), term('Shared[tiab]'), term('second[tiab]')] },
    { blockId: '2', additions: [term('shared[tiab]')] },
  ]);
  expect(mergeAdditions([second, first])).toEqual([
    second.additions[0],
    { blockId: '1', additions: [...second.additions[1]!.additions, term('first[tiab]')] },
  ]);
  expect(first.additions[0]!.additions[0]!.term).toBe(' shared[tiab] ');
});

test('dry-run はハッシュ・語数・出力先を確認し、.env・通信・書き込みを行わない', async () => {
  const fixture = setup();
  await main([...args, '--dry-run'], fixture.root);
  expect(config).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(existsSync(fixture.out)).toBe(false);
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('1: 4 語, 2: 1 語、合計 5 語'));
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining(fixture.out));
});

test.each([false, true])('既存出力を上書きしない（dry-run: %s）', async (dry) => {
  const fixture = setup();
  writeFileSync(fixture.out, '保存済み');
  await expect(main([...args, ...(dry ? ['--dry-run'] : [])], fixture.root)).rejects.toThrow('既に存在します');
  expect(readFileSync(fixture.out, 'utf8')).toBe('保存済み');
  expect(config).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each(['name', 'sha256', 'searchDate'])('元 margin の不一致を拒否する: %s', async (field) => {
  const fixture = setup();
  if (field === 'searchDate') fixture.second.searchDate = '2020-01-01';
  else if (field === 'name') fixture.second.c0 = { ...fixture.second.c0, name: 'other' };
  else fixture.second.c0 = { ...fixture.second.c0, sha256: 'different' };
  fixture.save(fixture.second);
  await expect(main([...args, '--dry-run'], fixture.root)).rejects.toThrow(field === 'searchDate' ? '検索日が一致しません' : field === 'name' ? 'C0 名が一致しません' : 'C0 ハッシュが一致しません');
  expect(config).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each(['margin', 'c0', 'reference', 'date', 'missing'])('破損・参照不一致・欠落を dry-run でも拒否する: %s', async (kind) => {
  const fixture = setup();
  if (kind === 'margin' || kind === 'c0') {
    const path = kind === 'margin' ? join(fixture.dir, 'margin', 'second.json') : join(fixture.dir, 'c0', 'criteria-only-draft1.json');
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    artifact.sha256 = 'broken';
    writeFileSync(path, JSON.stringify(artifact));
  } else if (kind === 'reference') {
    for (const margin of [fixture.first, fixture.second]) {
      margin.c0 = { ...margin.c0, sha256: 'different' };
      fixture.save(margin);
    }
  } else if (kind === 'date') {
    writeFileSync(join(fixture.dir, 'case.json'), JSON.stringify({ searchDate: '2020-01-01' }));
  }
  const input = kind === 'missing' ? ['--case', caseId, '--margins', 'first,missing', '--name', 'merged'] : args;
  await expect(main([...input, '--dry-run'], fixture.root)).rejects.toThrow(kind === 'date' ? '検索日が一致しません' : kind === 'missing' ? '見つかりません' : 'ハッシュが一致しません');
  expect(config).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('製品の式と一致し、ESearch 2 回だけで実測して sources を含む読める fixture を保存する', async () => {
  const fixture = setup();
  fixture.first.additions[0]!.additions[0]!.rationale = 'fake-ncbi-secret fake-gemini-secret';
  fixture.save(fixture.first);
  const calls: URLSearchParams[] = [];
  jest.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe('eutils.ncbi.nlm.nih.gov');
    expect(url.pathname).toMatch(/\/esearch.fcgi$/);
    const params = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : url.searchParams;
    calls.push(params);
    return new Response(JSON.stringify({ esearchresult: { count: calls.length === 1 ? '123' : '456', idlist: [] } }));
  });
  await main(args, fixture.root);
  expect(config).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(2);
  for (const params of calls) {
    expect(params.get('retmax')).toBe('0');
    expect(params.get('datetype')).toBe('crdt');
    expect(params.get('maxdate')).toBe('2022/03/31');
    expect(params.get('api_key')).toBe('fake-ncbi-secret');
  }
  const artifact = loadMarginArtifact(fixture.root, caseId, 'merged');
  const c0 = loadC0Artifact(fixture.root, caseId, 'criteria-only-draft1');
  const originalQuery = expandFormula(c0.formula).trim();
  const broadenedQuery = expandFormula(buildBroadenedFormula(c0.formula, mergeAdditions([fixture.first, fixture.second]))).trim();
  expect(artifact.marginQuery).toBe(buildMarginQuery(broadenedQuery, originalQuery));
  expect(calls.map((params) => params.get('term'))).toEqual([originalQuery, artifact.marginQuery]);
  expect(artifact).toMatchObject({ broadenedQuery, model: 'merged', originalHits: 123, marginHits: 456,
    sources: [fixture.first, fixture.second].map((margin) => ({ name: margin.name, sha256: hashMarginContent(margin) })) });
  const saved = readFileSync(fixture.out, 'utf8');
  expect(saved).not.toContain('fake-ncbi-secret');
  expect(saved).not.toContain('fake-gemini-secret');
  artifact.sources![0]!.sha256 = 'tampered';
  writeFileSync(fixture.out, JSON.stringify(artifact));
  expect(() => loadMarginArtifact(fixture.root, caseId, 'merged')).toThrow('ハッシュが一致しません');
});

test('不正な件数を 0 件にせず保存を拒否する', async () => {
  const fixture = setup();
  jest.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ esearchresult: { idlist: [] } })));
  await expect(main(args, fixture.root)).rejects.toThrow();
  expect(existsSync(fixture.out)).toBe(false);
});

test('sources がない既存の凍結 margin のハッシュを維持する', () => {
  const artifact = loadMarginArtifact(join(__dirname, 'fixtures'), caseId, 'criteria-only-draft1-margin1');
  expect(artifact.sources).toBeUndefined();
  const { sha256, ...content } = artifact;
  expect(hashMarginContent(content)).toBe(sha256);
});
