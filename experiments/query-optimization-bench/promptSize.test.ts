/** @jest-environment node */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OptimizationTrial } from '../../src/features/formula/skills/optimizeQuery';
import { buildInputBase, createFakeProvider, measurePromptSizes, main } from './promptSize';

const initialFormula = { blocks: [
  { id: '1', expression: 'drug$[tiab]', isCombination: false },
  { id: '2', expression: '#1', isCombination: true },
], combinationExpression: '#1' };

function trial(overrides: Partial<OptimizationTrial>): OptimizationTrial {
  return { kind: 'proposal', candidateId: 'x', formula: initialFormula, accepted: false, reason: '',
    rationale: '', before: null, after: null, apiEvents: [], ...overrides };
}

test('フェイク provider は通信せず、受け取ったメッセージを記録して最小の finish 応答を返す', async () => {
  const { provider, calls } = createFakeProvider();
  const response = await provider.chat([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(response.text)).toMatchObject({ action: 'finish', finish_kind: 'no_change_needed' });
});

test('buildInputBase は run.json に無い項目をダミーで埋め、注記に残す', () => {
  const trials = [trial({ kind: 'initial', candidateId: 'initial',
    after: { id: 'm1', fingerprint: 'f', measuredAt: '2026-01-01', totalHits: 10,
      capturedPmids: ['11'], missedPmids: ['22'], blocks: [] } })];
  const base = buildInputBase({}, trials);
  expect(base.maxHits).toBe(2000);
  expect(base.approvedBlocks).toEqual([{ id: '1', approvedBlockId: 'approved-1', label: 'ブロック1' }]);
  expect(base.seedPapers).toEqual([{ pmid: '11', title: null }, { pmid: '22', title: null }]);
  expect(base.notes.join(' ')).toContain('研究基準');
  expect(base.notes.join(' ')).toContain('maxHits');
});

test('buildInputBase は run.json の maxHits を優先して使う', () => {
  const trials = [trial({ kind: 'initial' })];
  const base = buildInputBase({ maxHits: 500 }, trials);
  expect(base.maxHits).toBe(500);
  expect(base.notes.join(' ')).not.toContain('maxHits');
});

test('measurePromptSizes は試行数と同じ件数の行を返し、履歴が増えるほど user プロンプトが伸びる', async () => {
  const trials = [
    trial({ kind: 'initial', candidateId: 'initial', accepted: true,
      after: { id: 'm1', fingerprint: 'f1', measuredAt: '2026-01-01', totalHits: 100,
        capturedPmids: ['11'], missedPmids: [], blocks: [] } }),
    trial({ kind: 'proposal', candidateId: 'candidate-1', accepted: false, reason: '改善なし',
      before: { id: 'm1', fingerprint: 'f1', measuredAt: '2026-01-01', totalHits: 100,
        capturedPmids: ['11'], missedPmids: [], blocks: [] },
      after: { id: 'm2', fingerprint: 'f2', measuredAt: '2026-01-02', totalHits: 90,
        capturedPmids: ['11'], missedPmids: [], blocks: [] } }),
  ];
  const base = buildInputBase({ maxHits: 100 }, trials);
  const rows = await measurePromptSizes(trials, base);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.k).toBe(1);
  expect(rows[1]!.k).toBe(2);
  expect(rows[1]!.userChars).toBeGreaterThan(rows[0]!.userChars);
  expect(rows.every((row) => row.systemChars > 0)).toBe(true);
});

describe('main', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prompt-size-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('run.json を読み、CSV と run ごとの最大 userChars を標準出力へ書く', async () => {
    const runPath = join(dir, 'run.json');
    writeFileSync(runPath, JSON.stringify({ maxHits: 100, optimization: { trials: [
      { kind: 'initial', candidateId: 'initial', formula: initialFormula, accepted: true, reason: '', rationale: '',
        before: null, after: { id: 'm1', fingerprint: 'f1', measuredAt: '2026-01-01', totalHits: 10,
          capturedPmids: ['11'], missedPmids: [], blocks: [] }, apiEvents: [] },
    ] } }));
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await main([runPath]);
      const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('k,userChars,systemChars');
      expect(output).toContain('1,');
      expect(output).toContain(`${runPath}: 最大 userChars =`);
    } finally { stdout.mockRestore(); }
  });

  test('optimization.trials が無い run.json はエラーで落ちる', async () => {
    const runPath = join(dir, 'run.json');
    writeFileSync(runPath, JSON.stringify({ maxHits: 100 }));
    await expect(main([runPath])).rejects.toThrow('optimization.trials が見つかりません');
  });

  test('引数無しは使い方エラー', async () => {
    await expect(main([])).rejects.toThrow('使い方');
  });
});
