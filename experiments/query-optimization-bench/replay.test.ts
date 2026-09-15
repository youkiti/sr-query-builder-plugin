/** @jest-environment node */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES } from './prepare';
import { loadC0Artifact } from './c0Artifact';
import { createReplayLlmFactory, hashReplayFixture, loadReplayFixture, replayFixturePath, type ReplayFixtureContent } from './replay';
import type { LLMProvider } from '../../src/lib/llm/LLMProvider';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import { loggedFactory } from './run';

const validResponse = (targetBlockId = '1', proposedExpression = 'a[tiab] OR b[tiab]') => JSON.stringify({
  target_block_id: targetBlockId, proposed_expression: proposedExpression, added_terms: [], removed_terms: [],
  replaced_terms: [], rationale: 'stub', measurement_ids: [], mesh_requests: [],
});

const baseFixture: ReplayFixtureContent = {
  name: 'stub-fixture', caseId: 'case-a', c0: { name: 'criteria-only-draft1', sha256: 'deadbeef' },
  source: { runId: 'run-1', logs: [{ file: '0001_optimize_query.json', sha256: 'abc' }], description: 'テスト用' },
  responses: [validResponse()],
};

/** ファイル名は明示の fileName（既定は content.name）で決め、name フィールドとの不一致も作れるようにする。 */
function writeFixture(dir: string, caseId: string, content: ReplayFixtureContent, fileName = content.name): void {
  const path = replayFixturePath(dir, caseId, fileName);
  mkdirSync(join(dir, caseId, 'replay'), { recursive: true });
  writeFileSync(path, JSON.stringify(content));
}

describe('loadReplayFixture', () => {
  test('名前・ケース ID の不一致を拒否する', () => {
    const root = mkdtempSync(join(tmpdir(), 'replay-fixture-'));
    writeFixture(root, 'case-a', baseFixture);
    expect(loadReplayFixture(root, 'case-a', 'stub-fixture').name).toBe('stub-fixture');
    writeFixture(root, 'case-a', { ...baseFixture, name: 'other-name' }, 'stub-fixture');
    expect(() => loadReplayFixture(root, 'case-a', 'stub-fixture')).toThrow('name');
    writeFixture(root, 'case-b', { ...baseFixture, caseId: 'case-a' });
    expect(() => loadReplayFixture(root, 'case-b', 'stub-fixture')).toThrow('ケース ID');
  });

  test('--replay の名前は C0 と同じ命名規則を要求する', () => {
    const root = mkdtempSync(join(tmpdir(), 'replay-fixture-'));
    expect(() => loadReplayFixture(root, 'case-a', 'Bad_Name')).toThrow('英小文字');
    expect(() => loadReplayFixture(root, 'case-a', '1abc')).toThrow('英小文字');
  });

  test('存在しない fixture は明示的なメッセージで拒否する', () => {
    const root = mkdtempSync(join(tmpdir(), 'replay-fixture-'));
    expect(() => loadReplayFixture(root, 'case-a', 'missing')).toThrow('見つかりません');
  });

  test('c0 参照が欠けている・空文字なら拒否する', () => {
    const root = mkdtempSync(join(tmpdir(), 'replay-fixture-'));
    writeFixture(root, 'case-a', { ...baseFixture, c0: { name: '', sha256: 'deadbeef' } });
    expect(() => loadReplayFixture(root, 'case-a', 'stub-fixture')).toThrow('c0');
    writeFixture(root, 'case-a', { ...baseFixture, c0: undefined as unknown as ReplayFixtureContent['c0'] });
    expect(() => loadReplayFixture(root, 'case-a', 'stub-fixture')).toThrow('c0');
  });

  test('responses は 1 件以上必要で、各応答は JSON かつ target_block_id / proposed_expression を持つこと', () => {
    const root = mkdtempSync(join(tmpdir(), 'replay-fixture-'));
    writeFixture(root, 'case-a', { ...baseFixture, responses: [] });
    expect(() => loadReplayFixture(root, 'case-a', 'stub-fixture')).toThrow('1 件以上');
    writeFixture(root, 'case-a', { ...baseFixture, responses: ['not json'] });
    expect(() => loadReplayFixture(root, 'case-a', 'stub-fixture')).toThrow('パースできません');
    writeFixture(root, 'case-a', { ...baseFixture, responses: [JSON.stringify({ proposed_expression: 'a[tiab]' })] });
    expect(() => loadReplayFixture(root, 'case-a', 'stub-fixture')).toThrow('target_block_id');
    writeFixture(root, 'case-a', { ...baseFixture, responses: [JSON.stringify({ target_block_id: '1' })] });
    expect(() => loadReplayFixture(root, 'case-a', 'stub-fixture')).toThrow('proposed_expression');
    writeFixture(root, 'case-a', { ...baseFixture, responses: [validResponse(), validResponse('2', 'c[tiab]')] });
    expect(loadReplayFixture(root, 'case-a', 'stub-fixture').responses).toHaveLength(2);
  });

  test('実ファイル: pr104-r2 は検証を通り、criteria-only-draft2 と c0 の名前・ハッシュが一致する', () => {
    const fixture = loadReplayFixture(FIXTURES, 'r2-pdr-prognostic', 'pr104-r2');
    expect(fixture.caseId).toBe('r2-pdr-prognostic');
    expect(fixture.responses).toHaveLength(3);
    const c0 = loadC0Artifact(FIXTURES, 'r2-pdr-prognostic', 'criteria-only-draft2');
    expect(fixture.c0.name).toBe('criteria-only-draft2');
    expect(fixture.c0.sha256).toBe(c0.sha256);
  });
});

test('hashReplayFixture はキー順序に依存せず、内容が変われば変わる', () => {
  const reordered = Object.fromEntries(Object.entries(baseFixture).reverse()) as unknown as ReplayFixtureContent;
  expect(hashReplayFixture(baseFixture)).toBe(hashReplayFixture(reordered));
  expect(hashReplayFixture(baseFixture)).not.toBe(hashReplayFixture({ ...baseFixture, name: 'different' }));
});

function fakeRealFactory(): { factory: LlmProviderFactory; calls: string[] } {
  const calls: string[] = [];
  const factory: LlmProviderFactory = {
    model: 'real-model',
    forPurpose: (purpose) => {
      calls.push(purpose);
      const provider: LLMProvider = { providerId: 'gemini', model: 'real-model', chat: async () => ({ text: `{"purpose":"${purpose}"}`, tokensIn: 1, tokensOut: 1, raw: {} }) };
      return provider;
    },
  };
  return { factory, calls };
}

describe('createReplayLlmFactory', () => {
  test.each(['optimize_query', 'expand_recall'] as const)('%s の委譲先へ試行オプションを伝播する', async (purpose) => {
    const realChat = jest.fn().mockResolvedValue({ text: 'ok', tokensIn: 1, tokensOut: 1, raw: {} });
    const realFactory = loggedFactory({ providerId: 'gemini', model: 'test', chat: realChat }, jest.fn(), []);
    let replayChat!: jest.SpyInstance;
    const replay = createReplayLlmFactory('stub-fixture', [validResponse()], realFactory, (provider) => {
      replayChat = jest.spyOn(provider, 'chat');
      return loggedFactory(provider, jest.fn(), []);
    });
    const beforeAttempt = jest.fn();
    const signal = new AbortController().signal;
    const createSignal = jest.fn(() => signal);

    await replay.forPurpose(purpose, undefined, { beforeAttempt, createSignal }).chat([]);
    expect(beforeAttempt).toHaveBeenCalledTimes(1);
    expect(createSignal).toHaveBeenCalledTimes(1);
    const chat = purpose === 'optimize_query' ? replayChat : realChat;
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith([], { signal });
    expect(purpose === 'optimize_query' ? realChat : replayChat).not.toHaveBeenCalled();
  });

  test('optimize_query だけ固定応答を順に返し、他の purpose は実 factory に届く', async () => {
    const { factory: realFactory, calls: realCalls } = fakeRealFactory();
    const responses = [validResponse('1', 'a[tiab]'), validResponse('1', 'b[tiab]')];
    const replay = createReplayLlmFactory('stub-fixture', responses, realFactory,
      (provider) => ({ model: provider.model, forPurpose: () => provider }));
    expect(replay.model).toBe('real-model');

    const first = await replay.forPurpose('optimize_query').chat([]);
    expect(first.text).toBe(responses[0]);
    const second = await replay.forPurpose('optimize_query').chat([]);
    expect(second.text).toBe(responses[1]);
    expect(replay.calls()).toBe(2);
    expect(replay.used()).toBe(2);
    expect(replay.exhausted()).toBe(true);
    // shouldStop は forPurpose の呼び出し回数が応答数を超えた時点で true になる。
    expect(replay.shouldStop()).toBe(false);
    replay.forPurpose('optimize_query');
    expect(replay.calls()).toBe(3);
    expect(replay.shouldStop()).toBe(true);

    const other = await replay.forPurpose('expand_recall').chat([]);
    expect(JSON.parse(other.text)).toEqual({ purpose: 'expand_recall' });
    expect(realCalls).toEqual(['expand_recall']);
  });

  test('安全弁: 応答を使い切った後に chat が呼ばれたら例外を投げる', async () => {
    const { factory: realFactory } = fakeRealFactory();
    const replay = createReplayLlmFactory('stub-fixture', [validResponse()], realFactory,
      (provider) => ({ model: provider.model, forPurpose: () => provider }));
    const provider = replay.forPurpose('optimize_query');
    await provider.chat([]);
    await expect(provider.chat([])).rejects.toThrow('使い切った');
  });

  test('usage tracker への計上は buildLoggedFactory に onUsage を渡すかどうかで決まり、replay は関与しない', async () => {
    // createReplayLlmFactory 自身は onUsage を持たないため、渡された buildLoggedFactory が
    // onUsage を組み込まない限り使用量は計上されない（run.ts の配線を仕様として固定する）。
    const { factory: realFactory } = fakeRealFactory();
    const built: LLMProvider[] = [];
    const replay = createReplayLlmFactory('stub-fixture', [validResponse()], realFactory, (provider) => {
      built.push(provider);
      return { model: provider.model, forPurpose: () => provider };
    });
    await replay.forPurpose('optimize_query').chat([]);
    expect(built).toHaveLength(1);
    expect(built[0]!.model).toBe('replay:stub-fixture');
  });
});
