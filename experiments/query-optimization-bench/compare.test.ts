/** @jest-environment node */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRun, main, renderComparison } from './compare';
import type { RunResult } from './types';

const base: RunResult = { id: 'r1-mindfulness-smoking', runId: 'run-a', profileId: 'default', status: 'completed', startedAt: '',
  model: 'fake', searchDate: '2021-04-15', maxHits: 2000, maxIterations: 5, conditions: {}, apiCalls: { ncbi: 0, llm: 0 },
  apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [], seedSplit: 's20260912', gitCommit: 'aaa',
  c0: { source: 'frozen', id: 'seeded-draft1', sha256: 'sha-x', variant: 'seeded', draftIndex: 1 } };

function withC1(run: RunResult, capturedStudies: string[], hits: number): RunResult {
  return { ...run, conditions: { C1: { query: 'q', measurement: { status: 'success', hits, capturedPmids: [] },
    metrics: { heldOutRecall: capturedStudies.length > 0 ? 1 : 0, allStudyRecall: 1, hits, capturedStudies,
      capturedHeldOut: capturedStudies, knownIncludedReportShare: 0.5, recordsPerKnownIncludedStudy: hits / (capturedStudies.length || 1) } } } };
}

test('C0 が live または sha256 不一致なら比較を拒否する', () => {
  const a = withC1(base, ['x'], 100);
  const liveB = { ...withC1(base, ['x'], 100), c0: { source: 'live' as const } };
  expect(() => renderComparison(a, liveB)).toThrow('凍結 C0');
  const mismatched = { ...withC1(base, ['x'], 100), c0: { ...base.c0!, sha256: 'sha-y' } };
  expect(() => renderComparison(a, mismatched)).toThrow('sha256 が一致しません');
});

test('ケース・シード分割・maxHits の不一致も拒否する', () => {
  const a = withC1(base, ['x'], 100);
  expect(() => renderComparison(a, { ...a, id: 'other' })).toThrow('ケースが一致しません');
  expect(() => renderComparison(a, { ...a, seedSplit: 's1' })).toThrow('シード分割が一致しません');
  expect(() => renderComparison(a, { ...a, maxHits: 1000 })).toThrow('maxHits が一致しません');
  expect(() => renderComparison(a, { ...a, maxIterations: 3 })).toThrow('maxIterations が一致しません');
});

test('同一凍結 C0 の 2 run を比較し、C1 の増減を研究名で表示する', () => {
  const a = withC1(base, ['davis 2014a'], 100);
  const b = withC1({ ...base, runId: 'run-b', gitCommit: 'bbb' }, ['davis 2014a', 'davis 2014b'], 120);
  const text = renderComparison(a, b);
  expect(text).toContain('run-a');
  expect(text).toContain('run-b');
  expect(text).toContain('aaa');
  expect(text).toContain('bbb');
  expect(text).toContain('得た研究: davis 2014b');
  expect(text).toContain('outcome: improved');
});

test('指標が欠けている run は理由を出して比較しない', () => {
  const a = { ...base, conditions: {} };
  const b = withC1({ ...base, runId: 'run-b' }, ['davis 2014a'], 100);
  const text = renderComparison(a, b);
  expect(text).toContain('未計測');
  expect(text).toContain('指標が欠けているため比較できません');
});

test('loadRun/main は run.json を読んで標準出力へ書き出す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-'));
  const pathA = join(dir, 'a.json');
  const pathB = join(dir, 'b.json');
  writeFileSync(pathA, JSON.stringify(withC1(base, ['davis 2014a'], 100)));
  writeFileSync(pathB, JSON.stringify(withC1({ ...base, runId: 'run-b' }, ['davis 2014a'], 100)));
  expect(loadRun(pathA).id).toBe('r1-mindfulness-smoking');
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    main([pathA, pathB]);
    expect(stdout.mock.calls.some((call) => String(call[0]).includes('outcome: unchanged'))).toBe(true);
  } finally { stdout.mockRestore(); }
});


test('label・model・gitDirty・postHoc と欠測を表示し、モデル差と汚れを注意する', () => {
  const a = { ...base, label: 'baseline', gitDirty: false, postHoc: false };
  const b = { ...base, label: 'candidate', model: 'other', gitDirty: true, postHoc: true };
  const text = renderComparison(a, b);
  expect(text).toContain('| label | baseline | candidate |');
  expect(text).toContain('| model | fake | other |');
  expect(text).toContain('| gitDirty | false | true |');
  expect(text).toContain('| postHoc | false | true |');
  expect(text).toContain('⚠ モデルが異なるため、差にはモデルの違いが混ざる');
  expect(text).toContain('⚠ 作業ツリーが汚れた状態の run を含む');
  expect(renderComparison(b, a)).toContain('⚠ 作業ツリー');
  const plain = renderComparison(base, base);
  for (const field of ['label', 'gitDirty', 'postHoc']) expect(plain).toContain(`| ${field} | 欠測 | 欠測 |`);
  expect(plain).not.toContain('⚠');
});
