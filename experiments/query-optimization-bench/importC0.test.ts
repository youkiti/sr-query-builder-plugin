/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { importC0Content, main, parseImportArgs } from './importC0';
import { loadC0Artifact } from './c0Artifact';
import { installDomParser } from './domParser';
import type { GenerateC0Deps, GenerateC0Input } from './c0Generation';
import { generateDraftFormula } from '../../src/app/services/draftService';
import { GeminiProvider } from '../../src/lib/llm/GeminiProvider';
import type { BenchCase, FrozenSeeds } from './types';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/app/services/draftService', () => ({
  ...jest.requireActual('../../src/app/services/draftService'), generateDraftFormula: jest.fn(),
}));

const caseId = 'r1-mindfulness-smoking';
const markdown = '## PubMed/MEDLINE\n\n```\n#1 smoking[tiab]\n#2 mindfulness[tiab]\n#3 #1 AND #2\n```\n';
const extracted = { framework_type: 'custom', research_question: 'RQ', inclusion_criteria: 'include', exclusion_criteria: '',
  study_design: 'any', blocks: [{ block_label: 'Smoking', description: '喫煙' }, { block_label: 'Mindfulness', description: '介入' }],
  combination_expression: '#1 AND #2' };
const llmResponse = (value = extracted) => ({ text: JSON.stringify(value), tokensIn: 5, tokensOut: 7, raw: {} });
const groups = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, members: [{ studyId: id, pmids: [String(i + 1)] }], pmids: [String(i + 1)] }));
const seeds: FrozenSeeds = { name: 'without-one', selections: groups.slice(1).map((g) => ({ groupId: g.id, pmid: g.pmids[0]!, year: null })) };
const input: GenerateC0Input & { formulaMd: string; formulaPath: string } = {
  caseId, variant: 'criteria-only', draftIndex: 2, seedSplit: null, protocolText: '# プロトコル', formulaMd: markdown,
  formulaPath: '/unused/search_formula.md',
};
const searchResponse = (error = false) => new Response(JSON.stringify({ esearchresult: {
  count: '0', idlist: [], ...(error ? { errorlist: { phrasesnotfound: ['invalid'] } } : {}),
} }));
const articlesResponse = (pmids = ['2', '3', '4']) => new Response(`<PubmedArticleSet>${pmids.map((pmid) =>
  `<PubmedArticle><MedlineCitation><PMID>${pmid}</PMID><Article><ArticleTitle>文献 ${pmid}</ArticleTitle><Abstract><AbstractText>抄録 ${pmid}</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`
).join('')}</PubmedArticleSet>`);
function fakeDeps() {
  const chat = jest.fn().mockResolvedValue(llmResponse());
  const forPurpose = jest.fn(() => ({ model: 'fake', providerId: 'gemini' as const, chat }));
  const fetch = jest.fn().mockImplementation(async (url) => String(url).includes('efetch.fcgi') ? articlesResponse() : searchResponse());
  const deps: GenerateC0Deps = { llmFactory: { model: 'fake', forPurpose },
    eutils: { fetch, strictCounts: true, maxRetries: 0, rateLimiter: { acquire: async () => undefined } } };
  return { deps, chat, forPurpose, fetch };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'import-c0-'));
  const fixtures = join(root, 'fixtures');
  const results = join(root, 'results');
  const dir = join(fixtures, caseId);
  mkdirSync(dir, { recursive: true });
  const data: BenchCase = { id: caseId, pmcid: 'fake', searchDate: '2021-04-15', license: 'CC BY', protocolPath: 'protocol.md',
    gold: groups, heldOut: ['a'], seeds };
  writeFileSync(join(dir, 'case.json'), JSON.stringify(data));
  writeFileSync(join(dir, 'protocol.md'), input.protocolText);
  writeFileSync(join(dir, 'seeds-without-one.json'), JSON.stringify(seeds));
  const formulaPath = join(root, 'search_formula.md');
  writeFileSync(formulaPath, markdown);
  return { fixtures, results, dir, formulaPath };
}
const cliArgs = (formulaPath: string, variant = 'criteria-only') => ['--case', caseId, '--variant', variant, '--formula', formulaPath, '--draft', '2'];
let network: jest.SpyInstance;
let stdout: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  installDomParser();
  network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
});
afterEach(() => {
  expect(generateDraftFormula).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

test('CLI は凍結と同じ引数規則に加えて --formula を必須にする', () => {
  expect(parseImportArgs(cliArgs('formula.md'))).toMatchObject({ formulaPath: 'formula.md', draftIndex: 2, seed: 20260912 });
  expect(parseImportArgs([...cliArgs('formula.md', 'seeded'), '--seeds', 'without-one']).seed).toBe('without-one');
  expect(parseImportArgs([...cliArgs('formula.md', 'seeded'), '--seeds', '42']).seed).toBe(42);
  for (const args of [[], [...cliArgs('a'), '--formula', 'b'], [...cliArgs('a'), '--formula'], [...cliArgs('a'), '--seeds', '42']]) {
    expect(() => parseImportArgs(args)).toThrow();
  }
  expect(() => parseImportArgs([...cliArgs('a', 'seeded'), '--seeds', 's42'])).toThrow('--seeds');
});

test('式を生成せず extractProtocol だけを呼び、非結合ブロックと式全体を retmax=0 で検査する', async () => {
  const { deps, chat, forPurpose, fetch } = fakeDeps();
  const content = await importC0Content(input, deps);
  expect(forPurpose.mock.calls).toEqual([['extract_protocol']]);
  expect(chat).toHaveBeenCalledTimes(1);
  expect(content).toMatchObject({ source: 'import', sourceFilename: 'search_formula.md', formulaMd: markdown,
    seedContext: null, seedSplit: null, protocol: { researchQuestion: 'RQ' }, blocks: { blocks: [
      { blockLabel: 'Smoking', aiGenerated: true }, { blockLabel: 'Mindfulness', aiGenerated: true },
    ] } });
  expect(fetch.mock.calls.map(([url]) => Object.fromEntries(new URL(String(url)).searchParams))).toEqual([
    expect.objectContaining({ term: 'smoking[tiab]', retmax: '0' }),
    expect.objectContaining({ term: 'mindfulness[tiab]', retmax: '0' }),
    expect.objectContaining({ term: '(smoking[tiab]) AND (mindfulness[tiab])', retmax: '0' }),
  ]);
  expect(network).not.toHaveBeenCalled();
});

test('抽出ラベルと式の対応を各行に表示し、長い式は省略する', async () => {
  const { deps } = fakeDeps();
  const expression = 'smoking[tiab] OR '.repeat(8) + 'tobacco[tiab]';
  await importC0Content({ ...input, formulaMd: markdown.replace('smoking[tiab]', expression) }, deps);
  expect(stdout).toHaveBeenCalledWith('目視で対応を確認してください（自動では検証していません）\n');
  expect(stdout).toHaveBeenCalledWith(`#1 ⇔ 抽出ラベル Smoking ⇔ ${expression.slice(0, 80)}…\n`);
  expect(stdout).toHaveBeenCalledWith('#2 ⇔ 抽出ラベル Mindfulness ⇔ mindfulness[tiab]\n');
});

test('非結合 ID が 1, 2, 4 の式は抽出・通信前に拒否する', async () => {
  const { deps, chat, fetch } = fakeDeps();
  const formulaMd = '## PubMed\n```\n#1 A\n#2 B\n#3 #1 OR #2\n#4 C\n#5 #3 AND #4\n```';
  await expect(importC0Content({ ...input, formulaMd }, deps)).rejects.toThrow('実際の ID: 1, 2, 4');
  expect(chat).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  '#1 A\n#2 B\n#3 C\n#4 #1 OR #2\n#5 #4 AND #3',
  '#1 A\n#2 B\n#4 #1 OR #2\n#3 C\n#5 #4 AND #3',
])('非結合 ID が出現順に 1, 2, 3 なら結合行の位置によらず取り込める: %s', async (body) => {
  const { deps, chat } = fakeDeps();
  chat.mockResolvedValue(llmResponse({ ...extracted, blocks: [...extracted.blocks, { block_label: 'Third', description: '第三概念' }] }));
  const content = await importC0Content({ ...input, formulaMd: '## PubMed\n```\n' + body + '\n```' }, deps);
  expect(content.formula.blocks.filter((block) => !block.isCombination).map((block) => block.id)).toEqual(['1', '2', '3']);
});

test.each([false, true])('CLI の非結合 ID 検査は環境変数の読み込み前に効く（dry-run=%s）', async (dryRun) => {
  const { fixtures, results, formulaPath } = fixture();
  writeFileSync(formulaPath, '## PubMed\n```\n#1 A\n#2 B\n#3 #1 OR #2\n#4 C\n#5 #3 AND #4\n```');
  await expect(main([...cliArgs(formulaPath), ...(dryRun ? ['--dry-run'] : [])], fixtures, results)).rejects.toThrow('実際の ID: 1, 2, 4');
  expect(config).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  expect(existsSync(results)).toBe(false);
});

test('取り込みの dry-run も既存 C0 との衝突を通信・環境変数の読み込み前に拒否する', async () => {
  const { fixtures, results, dir, formulaPath } = fixture();
  mkdirSync(join(dir, 'c0'));
  const path = join(dir, 'c0', 'criteria-only-draft2.json');
  writeFileSync(path, '{}');
  await expect(main([...cliArgs(formulaPath), '--dry-run'], fixtures, results)).rejects.toThrow('既に存在します');
  expect(config).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  expect(readFileSync(path, 'utf8')).toBe('{}');
  expect(existsSync(results)).toBe(false);
});

test('非結合ブロック数と抽出 blocks の数が不一致なら実測前に拒否する', async () => {
  const { deps, chat, fetch } = fakeDeps();
  chat.mockResolvedValue(llmResponse({ ...extracted, blocks: extracted.blocks.slice(0, 1) }));
  await expect(importC0Content(input, deps)).rejects.toThrow('非結合ブロック数（2）とプロトコルから抽出した blocks.blocks の数（1）');
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['不正な Markdown', '## PubMed\n```\n\n```', '## PubMed\n```\n#1 #2\n#2 #1\n```'])('パース・構造検証に失敗した式は通信前に拒否する: %s', async (formulaMd) => {
  const { deps, chat, fetch } = fakeDeps();
  await expect(importC0Content({ ...input, formulaMd }, deps)).rejects.toThrow();
  expect(chat).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test('seeded は efetch した全シードのタイトル・抄録を文脈に記録する', async () => {
  const { deps, fetch } = fakeDeps();
  const content = await importC0Content({ ...input, variant: 'seeded', seedSplit: 'without-one', seeds }, deps);
  expect(content.seedSplit).toBe('without-one');
  expect(content.seedContext).toMatchObject({ titles: ['文献 2', '文献 3', '文献 4'], samples: [
    { title: '文献 2', abstract: '抄録 2' }, { title: '文献 3', abstract: '抄録 3' }, { title: '文献 4', abstract: '抄録 4' },
  ] });
  expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get('id')).toBe('2,3,4');
});

test('seeded は efetch の部分欠落を許容しない', async () => {
  const { deps, fetch } = fakeDeps();
  fetch.mockImplementation(async () => articlesResponse(['2', '3']));
  await expect(importC0Content({ ...input, variant: 'seeded', seedSplit: 'without-one', seeds }, deps)).rejects.toThrow('missing: 4');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('実測エラーは各ブロックと式全体をまとめて報告する', async () => {
  const { deps, fetch } = fakeDeps();
  fetch.mockImplementation(async () => searchResponse(true));
  await expect(importC0Content(input, deps)).rejects.toThrow(/#1:.*\n#2:.*\n式全体:.*\n実測できない C0 は凍結しない/);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test('dry-run はシード無し criteria-only の出力先・ローカル検証だけを表示し、通信・書き込みしない', async () => {
  const { fixtures, results, dir, formulaPath } = fixture();
  await main([...cliArgs(formulaPath), '--dry-run'], fixtures, results);
  expect(network).not.toHaveBeenCalled();
  expect(config).not.toHaveBeenCalled();
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining(join(dir, 'c0', 'criteria-only-draft2.json')));
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining('非結合ブロック数=2'));
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining('実測は未実施'));
  expect(existsSync(join(dir, 'c0'))).toBe(false);
  expect(existsSync(results)).toBe(false);
  await main([...cliArgs(formulaPath, 'seeded'), '--seeds', 'without-one', '--dry-run'], fixtures, results);
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining('seeded-draft2-without-one.json'));
});

test.each([false, true])('CLI は実測後だけハッシュ付き C0 を保存し、LLM ログも共通の場所に残す（構文エラー=%s）', async (syntaxError) => {
  const { fixtures, results, dir, formulaPath } = fixture();
  const chat = jest.spyOn(GeminiProvider.prototype, 'chat').mockResolvedValue(llmResponse());
  network.mockImplementation(async (url) => String(url).includes('efetch.fcgi') ? articlesResponse() : searchResponse(syntaxError));
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'fake-key';
  const name = 'seeded-draft2-without-one';
  const args = [...cliArgs(formulaPath, 'seeded'), '--seeds', 'without-one'];
  try {
    if (syntaxError) {
      await expect(main(args, fixtures, results)).rejects.toThrow('実測できない C0');
      expect(existsSync(join(dir, 'c0', `${name}.json`))).toBe(false);
    } else {
      await main(args, fixtures, results);
      expect(loadC0Artifact(fixtures, caseId, name)).toMatchObject({ source: 'import', sourceFilename: 'search_formula.md',
        seedSplit: 'without-one', formulaMd: markdown });
      const original = readFileSync(join(dir, 'c0', `${name}.json`), 'utf8');
      await expect(main(args, fixtures, results)).rejects.toThrow('既に存在します');
      expect(readFileSync(join(dir, 'c0', `${name}.json`), 'utf8')).toBe(original);
    }
    expect(chat).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(readFileSync(join(results, 'freeze-c0', caseId, name, 'llm', '0001_extract_protocol.json'), 'utf8'));
    expect(logged).toMatchObject({ purpose: 'extract_protocol', tokensIn: 5, tokensOut: 7 });
    for (const [url] of network.mock.calls.filter(([url]) => String(url).includes('esearch.fcgi'))) {
      expect(new URL(String(url)).searchParams.get('maxdate')).toBe('2021/04/15');
    }
  } finally {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
  }
});
