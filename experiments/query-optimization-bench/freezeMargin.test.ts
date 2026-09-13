/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { hashC0Content, type C0Artifact } from './c0Artifact';
import { hashMarginContent, loadMarginArtifact, main, parseFreezeMarginArgs } from './freezeMargin';
import { sharedEutilsRateLimiters } from '../../src/lib/ncbi/eutils';

jest.mock('dotenv', () => ({ config: jest.fn() }));
const caseId = 'r3-vascular-bleeding';
const args = ['--case', caseId, '--c0', 'criteria-only-draft1'];
const name = 'criteria-only-draft1-margin1';
const oldGemini = process.env.GEMINI_API_KEY;
const oldNcbi = process.env.NCBI_API_KEY;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'freeze-margin-'));
  const results = join(root, 'results');
  const dir = join(root, caseId);
  mkdirSync(join(dir, 'c0'), { recursive: true });
  const original = JSON.parse(readFileSync(join(__dirname, 'fixtures', caseId, 'c0', 'criteria-only-draft1.json'), 'utf8')) as C0Artifact;
  const { sha256, ...content } = original;
  expect(hashC0Content(content)).toBe(sha256);
  content.formula = { blocks: [{ id: '1', expression: 'base[tiab]', isCombination: false },
    { id: '2', expression: '#1', isCombination: true }], combinationExpression: '#1' };
  writeFileSync(join(dir, 'c0', 'criteria-only-draft1.json'), JSON.stringify({ ...content, sha256: hashC0Content(content) }));
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ id: caseId, searchDate: '2022-03-31' }));
  return { root, dir, results, out: join(dir, 'margin', `${name}.json`) };
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'fake-gemini-secret';
  process.env.NCBI_API_KEY = 'fake-ncbi-secret';
  jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire').mockResolvedValue(undefined);
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  if (oldGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGemini;
  if (oldNcbi === undefined) delete process.env.NCBI_API_KEY; else process.env.NCBI_API_KEY = oldNcbi;
});

test('凍結引数の既定値と不正値・重複・未知の引数', () => {
  expect(parseFreezeMarginArgs(args)).toEqual({ caseId, c0Name: 'criteria-only-draft1', draftIndex: 1, dryRun: false });
  expect(parseFreezeMarginArgs([...args, '--draft', '2', '--dry-run']).draftIndex).toBe(2);
  for (const invalid of [[], ['--case', 'unknown', '--c0', 'valid'], ['--case', caseId],
    ['--case', caseId, '--c0', '../escape'], [...args, '--draft', '0'], [...args, '--draft', '1.5'],
    [...args, '--draft', 'no'], [...args, '--unknown'], [...args, '--c0', 'duplicate']]) {
    expect(() => parseFreezeMarginArgs(invalid)).toThrow();
  }
});

test('dry-run は C0 検証とパス表示のみで .env・通信・書き込みを行わない', async () => {
  const fixture = setup();
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実通信禁止'));
  await main([...args, '--dry-run'], fixture.root, fixture.results);
  expect(network).not.toHaveBeenCalled();
  expect(config).not.toHaveBeenCalled();
  expect(existsSync(fixture.out)).toBe(false);
  expect(existsSync(fixture.results)).toBe(false);
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining(fixture.out));
});

test.each([false, true])('既存ファイルを上書きしない（dry-run: %s）', async (dry) => {
  const fixture = setup();
  mkdirSync(join(fixture.dir, 'margin'));
  writeFileSync(fixture.out, '保存済み');
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実通信禁止'));
  await expect(main([...args, ...(dry ? ['--dry-run'] : [])], fixture.root, fixture.results)).rejects.toThrow('既に存在します');
  expect(readFileSync(fixture.out, 'utf8')).toBe('保存済み');
  expect(network).not.toHaveBeenCalled();
  expect(config).not.toHaveBeenCalled();
});

test('C0 のハッシュ破損を dry-run でも拒否する', async () => {
  const fixture = setup();
  const path = join(fixture.dir, 'c0', 'criteria-only-draft1.json');
  const c0 = JSON.parse(readFileSync(path, 'utf8'));
  c0.sha256 = '壊れたハッシュ';
  writeFileSync(path, JSON.stringify(c0));
  await expect(main([...args, '--dry-run'], fixture.root, fixture.results)).rejects.toThrow('ハッシュが一致しません');
});

test.each([false, true])('LLM 1 回と件数取得 2 回で凍結する。拡張語なしは保存しない（空: %s）', async (empty) => {
  const fixture = setup();
  const calls: { url: URL; params: URLSearchParams; body: string }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const body = String(init?.body ?? '');
    const params = init?.method === 'POST' ? new URLSearchParams(body) : url.searchParams;
    calls.push({ url, params, body });
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const text = JSON.stringify({ blocks: empty ? [] : [{ id: '1', additions: [
        { term: 'outside[tiab]', axis: 'freeword', rationale: 'fake-gemini-secret fake-ncbi-secret' },
      ] }] });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 } }));
    }
    if (url.pathname.endsWith('/esearch.fcgi')) return new Response(JSON.stringify({ esearchresult: { count: '10', idlist: [] } }));
    throw new Error('想定外の通信');
  });
  if (empty) {
    await expect(main(args, fixture.root, fixture.results)).rejects.toThrow('拡張語が 0 件');
    expect(existsSync(fixture.out)).toBe(false);
    expect(calls).toHaveLength(1);
    return;
  }
  await main(args, fixture.root, fixture.results);
  expect(calls).toHaveLength(3);
  expect(calls[0]!.body).toContain('#1 base[tiab]');
  expect(calls[0]!.body).not.toContain('#2');
  for (const call of calls.slice(1)) {
    expect(call.params.get('retmax')).toBe('0');
    expect(call.params.get('datetype')).toBe('crdt');
    expect(call.params.get('maxdate')).toBe('2022/03/31');
  }
  const artifact = loadMarginArtifact(fixture.root, caseId, name);
  expect(artifact.marginQuery).toBe('(((base[tiab]) OR outside[tiab])) NOT ((base[tiab]))');
  expect(artifact).toMatchObject({ originalHits: 10, marginHits: 10, searchDate: '2022-03-31', name });
  const { sha256, ...content } = artifact;
  expect(hashMarginContent(content)).toBe(sha256);
  const log = readFileSync(join(fixture.results, 'freeze-margin', caseId, name, 'llm', '0001_expand_recall.json'), 'utf8');
  const saved = readFileSync(fixture.out, 'utf8');
  for (const text of [log, saved]) {
    expect(text).not.toContain('fake-gemini-secret');
    expect(text).not.toContain('fake-ncbi-secret');
  }
  expect(JSON.parse(log)).toMatchObject({ purpose: 'expand_recall', tokensIn: 5, tokensOut: 7 });
});
