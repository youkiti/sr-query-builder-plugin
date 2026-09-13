/** @jest-environment node */
import { loggedFactory, main, memoryCheckpoint, parseArgs } from './run';
import { reportRows, renderCsv, renderMarkdown } from './report';
import type { RunResult } from './types';

test('CLI から未知ケース・未知プロファイルを拒否し、既定値を解決する', () => {
  expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  expect(parseArgs([]).profile).toEqual({ id: 'default', maxHits: 2000, maxIterations: 5 });
  expect(parseArgs([]).seed).toBe(20260912);
  expect(parseArgs([]).postHoc).toBe(false);
  expect(parseArgs(['--profile', 'tight-1000']).profile).toEqual({ id: 'tight-1000', maxHits: 1000, maxIterations: 5 });
  expect(() => parseArgs(['--profile', 'unknown'])).toThrow('未知のプロファイル');
  expect(() => parseArgs(['--profile'])).toThrow();
  expect(() => parseArgs(['--maxHits', '5'])).toThrow();
  expect(() => parseArgs(['--max-hits=1000'])).toThrow();
  expect(() => parseArgs(['--max-iterations', '10'])).toThrow();
  expect(() => parseArgs(['--case', 'unknown'])).toThrow();
});
test('--max-hits は事後探索の custom プロファイルを発行し、--profile と同時指定できない', () => {
  const parsed = parseArgs(['--max-hits', '1000']);
  expect(parsed.profile).toEqual({ id: 'custom-1000', maxHits: 1000, maxIterations: 5 });
  expect(parsed.postHoc).toBe(true);
  expect(() => parseArgs(['--max-hits', '0'])).toThrow('正の整数');
  expect(() => parseArgs(['--max-hits', 'abc'])).toThrow('正の整数');
  expect(() => parseArgs(['--profile', 'tight-1000', '--max-hits', '1000'])).toThrow('同時に指定できません');
});
test('--seeds は分割用の乱数を受け取り、既定は SEED', () => {
  expect(parseArgs(['--seeds', '42']).seed).toBe(42);
  expect(() => parseArgs(['--seeds', 'abc'])).toThrow();
});
test('--c0 は名前をそのまま受け取る', () => {
  expect(parseArgs(['--c0', 'seeded-draft1']).c0Name).toBe('seeded-draft1');
  expect(parseArgs([]).c0Name).toBeUndefined();
});
test('checkpoint はメモリだけを使う', async () => {
  const checkpoint = memoryCheckpoint();
  expect(await checkpoint.read('x')).toBeUndefined();
  await checkpoint.write({ x: { value: 1 } });
  expect(await checkpoint.read('x')).toEqual({ value: 1 });
});
test('purpose・全文・トークン・所要時間を成功時と失敗時に保存する', async () => {
  const write = jest.fn();
  const paths: string[] = [];
  const chat = jest.fn().mockResolvedValueOnce({ text: 'full response', tokensIn: 3, tokensOut: 4, raw: {} }).mockRejectedValueOnce(new Error('offline'));
  const factory = loggedFactory({ model: 'fake', providerId: 'gemini', chat }, write, paths);
  await factory.forPurpose('extract_protocol').chat([{ role: 'user', content: 'full prompt' }]);
  await expect(factory.forPurpose('draft_block').chat([])).rejects.toThrow('offline');
  expect(paths).toEqual(['llm/0001_extract_protocol.json', 'llm/0002_draft_block.json']);
  expect(write.mock.calls[0]![1]).toMatchObject({ purpose: 'extract_protocol', tokensIn: 3, tokensOut: 4, latencyMs: expect.any(Number),
    messages: [{ role: 'user', content: 'full prompt' }], response: { text: 'full response' } });
  expect(write.mock.calls[1]![1]).toMatchObject({ error: 'offline', response: null });
});
test('dry-run は実ネットワークを呼ばず全 fixture を読む', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  try {
    await main(['--dry-run']);
    await main(['--profile', 'tight-1000', '--dry-run']);
    await main(['--max-hits', '500', '--dry-run']);
    await main(['--seeds', '20260912', '--dry-run']);
    expect(fetch).not.toHaveBeenCalled();
  }
  finally { fetch.mockRestore(); }
});
test('報告は失敗と B1 欠測を残し、B1 入力があれば未計測の式を表示する', () => {
  const run: RunResult = { id: 'case', runId: 'run', status: 'failed', startedAt: '', model: 'fake', searchDate: '2021-04-15',
    profileId: 'default', maxHits: 10000, maxIterations: 5, conditions: {}, apiCalls: { ncbi: 1, llm: 2 }, apiElapsedMs: { ncbi: 1, llm: 2 }, elapsedMs: 3, llmLogs: [] };
  expect(reportRows([run])[3]!.slice(0, 5)).toEqual(['default', 'case', 'B1', '欠測', '欠測']);
  expect(reportRows([run], { case: 'original' })[3]).toContain('original');
  expect(renderCsv([['a,b', '"x"', 'a\nb']])).toContain('"a,b","""x""","a\nb"');
  expect(renderMarkdown([['a'], ['x|y\nz']])).toContain('x\\|y<br>z');
});
