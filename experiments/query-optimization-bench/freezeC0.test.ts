/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateC0Content, loadFreezeSeeds, main, parseFreezeArgs } from './freezeC0';
import { hashC0Content } from './c0Artifact';
import { validateC0Formula } from './c0Generation';
import { extractProtocol } from '../../src/features/formula/skills/extractProtocol';
import { generateDraftFormula } from '../../src/app/services/draftService';
import { efetchArticles, type EfetchArticle } from '../../src/lib/ncbi';
import { esearch, EutilsError } from '../../src/lib/ncbi/eutils';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import type { BenchCase, FrozenSeeds } from './types';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/features/formula/skills/extractProtocol', () => ({ extractProtocol: jest.fn() }));
jest.mock('../../src/app/services/draftService', () => {
  const actual = jest.requireActual<typeof import('../../src/app/services/draftService')>('../../src/app/services/draftService');
  return { ...actual, generateDraftFormula: jest.fn() };
});
jest.mock('../../src/lib/ncbi', () => ({ ...jest.requireActual('../../src/lib/ncbi'), efetchArticles: jest.fn() }));
jest.mock('../../src/lib/ncbi/eutils', () => ({ ...jest.requireActual('../../src/lib/ncbi/eutils'), esearch: jest.fn() }));

const formula = { blocks: [{ id: '1', expression: 'smoking[tiab]', isCombination: false }], combinationExpression: null };
const fakeDraft = { formula, markdown: '#1 smoking[tiab]', filter: { excessFilters: [], excessHitCount: 0 },
  blockSkeletons: [], meshSuggestions: [], freewordSuggestions: [], blockHits: [] } as unknown as Awaited<ReturnType<typeof generateDraftFormula>>;
const llmFactory: LlmProviderFactory = { model: 'fake-model', forPurpose: () => ({ model: 'fake-model', providerId: 'gemini', chat: jest.fn() }) };
const groups = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, members: [{ studyId: id, pmids: [String(i + 1)] }], pmids: [String(i + 1)] }));
const seeds: FrozenSeeds = { seed: 20260912, selections: groups.slice(0, 3).map((g) => ({ groupId: g.id, pmid: g.pmids[0]!, year: null })) };
const seedArticle = (pmid: string): EfetchArticle => ({ pmid, title: `Seed title ${pmid}`, year: 2020, meshHeadings: [], meshDetails: [],
  abstract: 'abstract', journal: null, authors: [], volume: null, issue: null, pages: null, doi: null });

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(extractProtocol).mockResolvedValue({ frameworkType: 'custom', researchQuestion: 'RQ', inclusionCriteria: 'include',
    exclusionCriteria: '', studyDesign: 'any', blocks: [{ blockLabel: 'Concept', description: 'description' }], combinationExpression: '#1' });
  jest.mocked(generateDraftFormula).mockResolvedValue(fakeDraft);
  jest.mocked(esearch).mockResolvedValue({ count: 10, pmids: [] });
  // 既定は 3 件の凍結シードすべてが efetch で取得できるケース。欠落ケースは専用テストで上書きする。
  jest.mocked(efetchArticles).mockResolvedValue(['1', '2', '3'].map(seedArticle));
});

test('parseFreezeArgs は必須引数を検証し、既定 draft=1・seed=SEED を補う', () => {
  expect(parseFreezeArgs(['--case', 'r1-mindfulness-smoking', '--variant', 'criteria-only']))
    .toEqual({ caseId: 'r1-mindfulness-smoking', variant: 'criteria-only', draftIndex: 1, seed: 20260912, dryRun: false });
  expect(parseFreezeArgs(['--case', 'r1-mindfulness-smoking', '--variant', 'seeded', '--draft', '2', '--seeds', '42', '--dry-run']))
    .toEqual({ caseId: 'r1-mindfulness-smoking', variant: 'seeded', draftIndex: 2, seed: 42, dryRun: true });
  expect(() => parseFreezeArgs(['--variant', 'seeded'])).toThrow('ケース ID');
  expect(() => parseFreezeArgs(['--case', 'unknown', '--variant', 'seeded'])).toThrow('ケース ID');
  expect(() => parseFreezeArgs(['--case', 'r1-mindfulness-smoking'])).toThrow('criteria-only または seeded');
  expect(() => parseFreezeArgs(['--case', 'r1-mindfulness-smoking', '--variant', 'other'])).toThrow('criteria-only または seeded');
  expect(() => parseFreezeArgs(['--case', 'r1-mindfulness-smoking', '--variant', 'seeded', '--draft', '0'])).toThrow('正の整数');
  expect(() => parseFreezeArgs(['--case', 'r1-mindfulness-smoking', '--variant', 'seeded', '--seeds', 'Invalid'])).toThrow('整数');
});

test('generateC0Content: criteria-only は efetchArticles を呼ばず、seedContext を空にする', async () => {
  const content = await generateC0Content({ caseId: 'r1-mindfulness-smoking', variant: 'criteria-only', draftIndex: 1, seedSplit: null,
    protocolText: 'protocol' }, { llmFactory, eutils: { fetch: jest.fn() } });
  expect(efetchArticles).not.toHaveBeenCalled();
  expect(content.seedContext).toBeNull();
  expect(content.formula).toEqual(formula);
  expect(content.targetHits).toBe(2000);
  expect(content.blockApproval).toBe('auto');
  expect(generateDraftFormula).toHaveBeenCalledWith(expect.objectContaining({ targetHits: 2000,
    seedContext: expect.objectContaining({ titles: [] }) }), expect.anything());
});

test.each([false, true])('generateC0Content: 実測エラーを全件集めて凍結を中止する（式全体も失敗: %s）', async (wholeFails) => {
  jest.mocked(generateDraftFormula).mockResolvedValue({ ...fakeDraft, formula: { blocks: [
    { id: '1', expression: 'invalid[Mesh]', isCombination: false },
    { id: '2', expression: 'smoking[tiab]', isCombination: false },
    { id: '3', expression: '#1 AND #2', isCombination: true },
  ], combinationExpression: '#1 AND #2' } });
  jest.mocked(esearch).mockImplementation(async (query) => {
    if (query === 'invalid[Mesh]') throw new EutilsError('構文エラー: phrase not found invalid', 200, true);
    if (wholeFails && query === '(invalid[Mesh]) AND (smoking[tiab])') throw new EutilsError('式の実測エラー', 200, true);
    return { count: 10, pmids: [] };
  });
  const eutils = { fetch: jest.fn(), strictCounts: true };
  await expect(generateC0Content({ caseId: 'r1-mindfulness-smoking', variant: 'criteria-only', draftIndex: 1,
    seedSplit: null, protocolText: 'protocol', seeds }, { llmFactory, eutils })).rejects.toThrow(
    '#1: 構文エラー: phrase not found invalid\n'
    + (wholeFails ? '式全体: 式の実測エラー\n' : '')
    + '実測できない C0 は凍結しない。再生成するには --draft で別番号を指定する');
  expect(jest.mocked(esearch).mock.calls).toEqual([
    ['invalid[Mesh]', eutils, { retmax: 0 }],
    ['smoking[tiab]', eutils, { retmax: 0 }],
    ['(invalid[Mesh]) AND (smoking[tiab])', eutils, { retmax: 0 }],
  ]);
});

test.each([
  new EutilsError('HTTP 503', 503),
  new Error('fetch failed'),
  '通信失敗',
])('validateC0Formula: 一時障害が混ざれば同じ番号で再試行できる: %s', async (transient) => {
  jest.mocked(esearch).mockRejectedValueOnce(new EutilsError('構文エラー', 200, true)).mockRejectedValueOnce(transient);
  const result = validateC0Formula(formula, { fetch: jest.fn() });
  await expect(result).rejects.toThrow('実測中に一時的な通信障害があったため凍結しない。同じ番号で再試行できる');
  await expect(result).rejects.not.toThrow('実測できない C0 は凍結しない');
  expect(esearch).toHaveBeenCalledTimes(2);
});

test.each([[10, 0], [0, 0]])('generateC0Content: 実測がすべて成功すれば 0 件でも内容を返す（ブロック %i 件、式全体 %i 件）', async (blockCount, wholeCount) => {
  jest.mocked(esearch).mockResolvedValueOnce({ count: blockCount, pmids: [] }).mockResolvedValueOnce({ count: wholeCount, pmids: [] });
  const eutils = { fetch: jest.fn(), strictCounts: true };
  const content = await generateC0Content({ caseId: 'r1-mindfulness-smoking', variant: 'criteria-only', draftIndex: 1,
    seedSplit: null, protocolText: 'protocol', seeds }, { llmFactory, eutils });
  expect(content.formula).toEqual(formula);
  expect(content.formulaMd).toBe(fakeDraft.markdown);
  expect(jest.mocked(esearch).mock.calls).toEqual([
    ['smoking[tiab]', eutils, { retmax: 0 }],
    ['smoking[tiab]', eutils, { retmax: 0 }],
  ]);
});

test('generateC0Content: seeded は凍結シードのタイトルを efetchArticles 経由で渡す', async () => {
  const content = await generateC0Content({ caseId: 'r1-mindfulness-smoking', variant: 'seeded', draftIndex: 1, seedSplit: 's20260912',
    protocolText: 'protocol', seeds }, { llmFactory, eutils: { fetch: jest.fn() } });
  expect(efetchArticles).toHaveBeenCalledWith(['1', '2', '3'], expect.anything());
  expect(content.seedContext).toEqual(expect.objectContaining({ titles: ['Seed title 1', 'Seed title 2', 'Seed title 3'] }));
  expect(content.seedSplit).toBe('s20260912');
  expect(generateDraftFormula).toHaveBeenCalledWith(expect.objectContaining({
    seedContext: expect.objectContaining({ titles: ['Seed title 1', 'Seed title 2', 'Seed title 3'] }) }), expect.anything());
});

test('generateC0Content: 凍結シードの一部が efetch で取得できないと空の seedContext で凍結せず例外を投げる（静かな劣化の禁止）', async () => {
  jest.mocked(efetchArticles).mockResolvedValue([seedArticle('1')]); // '2' '3' が欠落
  await expect(generateC0Content({ caseId: 'r1-mindfulness-smoking', variant: 'seeded', draftIndex: 1, seedSplit: 's20260912',
    protocolText: 'protocol', seeds }, { llmFactory, eutils: { fetch: jest.fn() } }))
    .rejects.toThrow(/missing: 2, 3/);
  expect(generateDraftFormula).not.toHaveBeenCalled();
});

function writeFixture(fixturesDir: string, caseId: string): void {
  const dir = join(fixturesDir, caseId);
  mkdirSync(dir, { recursive: true });
  const fixture: BenchCase = { id: caseId, pmcid: 'fake', searchDate: '2021-04-15', license: 'CC BY', protocolPath: 'protocol.md',
    gold: groups, heldOut: ['d'], seeds };
  writeFileSync(join(dir, 'case.json'), JSON.stringify(fixture));
  writeFileSync(join(dir, 'protocol.md'), '# protocol');
  writeFileSync(join(dir, 'seeds.json'), JSON.stringify(seeds));
}

test('main: dry-run は環境変数・ネットワーク無しで対象パスだけ表示する', async () => {
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const fixturesDir = mkdtempSync(join(tmpdir(), 'freezec0-dry-'));
    writeFixture(fixturesDir, 'r1-mindfulness-smoking');
    await main(['--case', 'r1-mindfulness-smoking', '--variant', 'seeded', '--dry-run'], fixturesDir);
    expect(network).not.toHaveBeenCalled();
    expect(stdout.mock.calls.some((call) => String(call[0]).includes('dry-run OK'))).toBe(true);
    expect(existsSync(join(fixturesDir, 'r1-mindfulness-smoking', 'c0'))).toBe(false);
  } finally { network.mockRestore(); stdout.mockRestore(); }
});

test('main: GEMINI_API_KEY 未設定なら実書き込み前に拒否する', async () => {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'freezec0-nokey-'));
  writeFixture(fixturesDir, 'r1-mindfulness-smoking');
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await expect(main(['--case', 'r1-mindfulness-smoking', '--variant', 'criteria-only'], fixturesDir)).rejects.toThrow('GEMINI_API_KEY');
  } finally { if (original !== undefined) process.env.GEMINI_API_KEY = original; }
});

test('main: 既存の凍結 C0 を上書きせず拒否する', async () => {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'freezec0-exists-'));
  writeFixture(fixturesDir, 'r1-mindfulness-smoking');
  mkdirSync(join(fixturesDir, 'r1-mindfulness-smoking', 'c0'), { recursive: true });
  writeFileSync(join(fixturesDir, 'r1-mindfulness-smoking', 'c0', 'criteria-only-draft1.json'), '{}');
  await expect(main(['--case', 'r1-mindfulness-smoking', '--variant', 'criteria-only'], fixturesDir)).rejects.toThrow('既に存在します');
});

test('main: dry-run も既存の凍結 C0 を環境変数・通信無しで拒否する', async () => {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'freezec0-dry-exists-'));
  writeFixture(fixturesDir, 'r1-mindfulness-smoking');
  const dir = join(fixturesDir, 'r1-mindfulness-smoking', 'c0');
  mkdirSync(dir);
  const path = join(dir, 'criteria-only-draft1.json');
  writeFileSync(path, '{}');
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  try {
    await expect(main(['--case', 'r1-mindfulness-smoking', '--variant', 'criteria-only', '--dry-run'], fixturesDir)).rejects.toThrow('既に存在します');
    expect(network).not.toHaveBeenCalled();
    expect(extractProtocol).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe('{}');
  } finally {
    network.mockRestore();
    if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
  }
});

test('main: 生成した内容をハッシュ付きで書き出し、既定 split では split 接尾辞を付けない', async () => {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'freezec0-write-'));
  const resultsDir = mkdtempSync(join(tmpdir(), 'freezec0-results-'));
  writeFixture(fixturesDir, 'r1-mindfulness-smoking');
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'fake-key';
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止（モック漏れ）'));
  try {
    await main(['--case', 'r1-mindfulness-smoking', '--variant', 'criteria-only'], fixturesDir, resultsDir);
    const outPath = join(fixturesDir, 'r1-mindfulness-smoking', 'c0', 'criteria-only-draft1.json');
    expect(existsSync(outPath)).toBe(true);
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    const { sha256, ...content } = written;
    expect(hashC0Content(content)).toBe(sha256);
    expect(written.seedSplit).toBeNull();
    expect(written.formula).toEqual(formula);
    expect(network).not.toHaveBeenCalled();
    // ハッシュ対象の内容にはログパスを含めない。
    expect(Object.keys(content)).not.toContain('llmLogs');
  } finally {
    network.mockRestore();
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
  }
});

test('main: LLM のプロンプト/レスポンス全文を run.ts と同じ loggedFactory で results/freeze-c0/ 配下に保存する', async () => {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'freezec0-log-'));
  const resultsDir = mkdtempSync(join(tmpdir(), 'freezec0-log-results-'));
  writeFixture(fixturesDir, 'r1-mindfulness-smoking');
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'super-secret-key';
  // extractProtocol を素通りさせず、実際に llmFactory.forPurpose(...).chat(...) を叩かせて
  // loggedFactory の write コールバックを発火させる（GeminiProvider の fetch はフェイクで完結し、実ネットワークは使わない）。
  jest.mocked(extractProtocol).mockImplementation(async (_text, provider) => {
    await provider.chat([{ role: 'user', content: 'extract' }], { responseFormat: 'json' });
    return { frameworkType: 'custom', researchQuestion: 'RQ', inclusionCriteria: 'include', exclusionCriteria: '',
      studyDesign: 'any', blocks: [{ blockLabel: 'Concept', description: 'description' }], combinationExpression: '#1' };
  });
  const geminiResponse = { candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 } };
  const network = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).includes('generativelanguage.googleapis.com')) return new Response(JSON.stringify(geminiResponse));
    throw new Error(`想定外の fetch: ${String(input)}`);
  });
  try {
    await main(['--case', 'r1-mindfulness-smoking', '--variant', 'criteria-only'], fixturesDir, resultsDir);
    const llmDir = join(resultsDir, 'freeze-c0', 'r1-mindfulness-smoking', 'criteria-only-draft1', 'llm');
    expect(existsSync(llmDir)).toBe(true);
    const logged = JSON.parse(readFileSync(join(llmDir, '0001_extract_protocol.json'), 'utf8'));
    expect(logged).toMatchObject({ purpose: 'extract_protocol', model: 'gemini-3.5-flash', tokensIn: 5, tokensOut: 7 });
  } finally {
    network.mockRestore();
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
  }
});

test('main: 既定分割は接尾辞なし、既定以外の分割は名前に split id を付ける', async () => {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'freezec0-split-'));
  const resultsDir = mkdtempSync(join(tmpdir(), 'freezec0-split-results-'));
  writeFixture(fixturesDir, 'r1-mindfulness-smoking');
  const altSeeds: FrozenSeeds = { seed: 42, selections: groups.slice(1, 4).map((g) => ({ groupId: g.id, pmid: g.pmids[0]!, year: null })) };
  writeFileSync(join(fixturesDir, 'r1-mindfulness-smoking', 'seeds-42.json'), JSON.stringify(altSeeds));
  jest.mocked(efetchArticles).mockImplementation(async (pmids) => pmids.map(seedArticle));
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'fake-key';
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  try {
    await main(['--case', 'r1-mindfulness-smoking', '--variant', 'seeded'], fixturesDir, resultsDir);
    expect(existsSync(join(fixturesDir, 'r1-mindfulness-smoking', 'c0', 'seeded-draft1.json'))).toBe(true);
    await main(['--case', 'r1-mindfulness-smoking', '--variant', 'seeded', '--seeds', '42'], fixturesDir, resultsDir);
    expect(existsSync(join(fixturesDir, 'r1-mindfulness-smoking', 'c0', 'seeded-draft1-s42.json'))).toBe(true);
    const defaultSplitContent = JSON.parse(readFileSync(join(fixturesDir, 'r1-mindfulness-smoking', 'c0', 'seeded-draft1.json'), 'utf8'));
    expect(defaultSplitContent.seedSplit).toBe('s20260912');
    const altSplitContent = JSON.parse(readFileSync(join(fixturesDir, 'r1-mindfulness-smoking', 'c0', 'seeded-draft1-s42.json'), 'utf8'));
    expect(altSplitContent.seedSplit).toBe('s42');
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
  }
});

test('criteria-only は --seeds を拒否し、未指定ならシードの読み込み・検証を省く', () => {
  expect(() => parseFreezeArgs(['--case', 'r1-mindfulness-smoking', '--variant', 'criteria-only', '--seeds', '42']))
    .toThrow('criteria-only では --seeds は指定できません');
  const load = jest.fn(() => { throw new Error('シードファイルがありません'); });
  expect(loadFreezeSeeds('criteria-only', '/unused', 20260912, groups, load)).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
  expect(() => loadFreezeSeeds('seeded', '/unused', 20260912, groups, load)).toThrow('シードファイルがありません');
  expect(() => loadFreezeSeeds('seeded', '/unused', 20260912, [], () => seeds)).toThrow('群構造');
});

test('main: seeded はシードファイル必須で seed の自己申告不一致を拒否する', async () => {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'freezec0-required-'));
  writeFixture(fixturesDir, 'r1-mindfulness-smoking');
  const args = ['--case', 'r1-mindfulness-smoking', '--variant', 'seeded', '--seeds', '42', '--dry-run'];
  await expect(main(args, fixturesDir)).rejects.toThrow('seeds-42.json が見つかりません');
  writeFileSync(join(fixturesDir, 'r1-mindfulness-smoking', 'seeds-42.json'), JSON.stringify(seeds));
  await expect(main(args, fixturesDir)).rejects.toThrow('要求した分割（42）と一致しません');
});

test('名前付き集合も seeded の分割指定として受け取り、criteria-only では拒否する', () => {
  const args = ['--case', 'r1-mindfulness-smoking', '--variant', 'seeded', '--seeds', 'without-one'];
  expect(parseFreezeArgs(args).seed).toBe('without-one');
  expect(() => parseFreezeArgs(args.map((arg) => arg === 'seeded' ? 'criteria-only' : arg))).toThrow('criteria-only では --seeds');
});

test('seeded はシード引数を省略した直接呼び出しも拒否する', async () => {
  await expect(generateC0Content({ caseId: 'r1-mindfulness-smoking', variant: 'seeded', draftIndex: 1,
    seedSplit: 's20260912', protocolText: 'protocol' }, { llmFactory, eutils: { fetch: jest.fn() } })).rejects.toThrow('シードが必要');
  expect(generateDraftFormula).not.toHaveBeenCalled();
});
