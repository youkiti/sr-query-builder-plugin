/** @jest-environment node */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PubmedFormula } from '@/lib/search-formula-md';
import {
  analyzeFeasibility, classifyContribution, classifyFollowUp, buildReport, renderReport, parseRunFile,
  type RunFile, type Trial, type Measurement, type DuplicationEvent, type Report,
} from './partialDeletionFeasibility';

// ---------------------------------------------------------------------------
// 共通フィクスチャ
// ---------------------------------------------------------------------------

/** ブロック #1 が `words` の OR 結合、ブロック #2 は固定、結合式は単純な AND。 */
function formula(words: string[]): PubmedFormula {
  return {
    blocks: [
      { id: '1', expression: `(${words.join(' OR ')})`, isCombination: false },
      { id: '2', expression: '"X"[tiab]', isCombination: false },
      { id: '3', expression: '#1 AND #2', isCombination: true },
    ],
    combinationExpression: '#1 AND #2',
  };
}

function measurement(overrides: Partial<Measurement> = {}): Measurement {
  return {
    fingerprint: 'fp-default',
    totalHits: 5000,
    capturedPmids: ['p1'],
    missedPmids: [],
    ...overrides,
  };
}

function trial(overrides: Partial<Trial> & { kind: string }): Trial {
  return {
    formula: formula(['"A"[tiab]', '"B"[tiab]', '"C"[tiab]']),
    before: null,
    after: null,
    duplicateOf: null,
    ...overrides,
  };
}

function run(overrides: Partial<RunFile> & { trials: Trial[] }): RunFile {
  return {
    runId: 'run-1',
    label: 'test-label',
    gitCommit: 'abc123',
    model: 'test-model',
    maxHits: 2000,
    stopReason: 'no_improvement',
    sourcePath: 'in-memory',
    ...overrides,
  };
}

const A = '"A"[tiab]';
const B = '"B"[tiab]';
const C = '"C"[tiab]';
const D = '"D"[tiab]';
const E = '"E"[tiab]';

/** 5 語ブロック（A〜E）の initial + 2 語削除（D,E）の held + 差し戻し + 重複、という標準系列。 */
function buildSuccessTrials(): Trial[] {
  const initialFormula = formula([A, B, C, D, E]);
  const heldFormula = formula([A, B, C]);
  const initialMeasurement = measurement({ fingerprint: 'fp-initial', totalHits: 5000 });
  return [
    trial({ kind: 'initial', formula: initialFormula, after: initialMeasurement, accepted: true }),
    trial({
      kind: 'proposal', formula: heldFormula, held: true, accepted: false,
      before: measurement({ fingerprint: 'fp-initial', capturedPmids: ['p1'] }),
      after: measurement({ fingerprint: 'fp-held', capturedPmids: ['p1'] }),
      changes: { targetBlockId: '1', addedTermsCount: 0, replacedTermsCount: 0 },
    }),
    trial({ kind: 'proposal', formula: formula(['"Z"[tiab]']), accepted: false, resubmissionRequested: true }),
    trial({ kind: 'proposal', formula: heldFormula, accepted: false, duplicateOf: 'candidate-2' }),
  ];
}

// ---------------------------------------------------------------------------
// 差し戻し直後の分類 4 種
// ---------------------------------------------------------------------------

describe('classifyFollowUp', () => {
  test('次の試行が無ければ no-next', () => {
    const trials = [trial({ kind: 'proposal', resubmissionRequested: true })];
    expect(classifyFollowUp(trials, 0)).toEqual({ kind: 'no-next' });
  });

  test('直後が finish なら finish（finishKind 付き）', () => {
    const trials = [
      trial({ kind: 'proposal', resubmissionRequested: true }),
      trial({ kind: 'finish', finishKind: 'no_change_needed' }),
    ];
    expect(classifyFollowUp(trials, 0)).toEqual({ kind: 'finish', finishKind: 'no_change_needed' });
  });

  test('直後が duplicateOf 付きなら same-formula', () => {
    const trials = [
      trial({ kind: 'proposal', resubmissionRequested: true }),
      trial({ kind: 'proposal', duplicateOf: 'candidate-1' }),
    ];
    expect(classifyFollowUp(trials, 0)).toEqual({ kind: 'same-formula' });
  });

  test.each([
    [{ accepted: true }, 'accepted'],
    [{ held: true }, 'held'],
    [{}, 'rejected'],
  ] as const)('直後が新案 proposal なら outcome を区別する: %j', (overrides, outcome) => {
    const trials = [
      trial({ kind: 'proposal', resubmissionRequested: true }),
      trial({ kind: 'proposal', ...overrides }),
    ];
    expect(classifyFollowUp(trials, 0)).toEqual({ kind: 'proposal', outcome });
  });
});

// ---------------------------------------------------------------------------
// 前提条件 a〜e
// ---------------------------------------------------------------------------

describe('analyzeFeasibility: 前提条件 a〜e', () => {
  test('正常系: 2 語削除の保留から候補が 2 件作れる', async () => {
    const events = await analyzeFeasibility([run({ trials: buildSuccessTrials() })]);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event!.bucket).toBe('resubmission');
    expect(event!.failedAt).toBeNull();
    expect(event!.candidates).toHaveLength(2);
    expect(event!.candidates.map((c) => c.removedTerm).sort()).toEqual([D, E].sort());
    expect(event!.candidates.every((c) => c.blockId === '1')).toBe(true);
  });

  test('a: 既知シードを全件捕捉していない（missedPmids が空でない）と候補を作らない', async () => {
    const trials = buildSuccessTrials();
    trials[0] = trial({
      kind: 'initial', formula: formula([A, B, C, D, E]), accepted: true,
      after: measurement({ fingerprint: 'fp-initial', totalHits: 5000, missedPmids: ['未捕捉'] }),
    });
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBe('a');
    expect(event!.candidates).toEqual([]);
  });

  test('b: totalHits が maxHits を超えていないと候補を作らない', async () => {
    const trials = buildSuccessTrials();
    trials[0] = trial({
      kind: 'initial', formula: formula([A, B, C, D, E]), accepted: true,
      after: measurement({ fingerprint: 'fp-initial', totalHits: 100 }),
    });
    const [event] = await analyzeFeasibility([run({ trials, maxHits: 2000 })]);
    expect(event!.failedAt).toBe('b');
    expect(event!.candidates).toEqual([]);
  });

  test('c: 結合式が単純な AND でない（OR を含む）と候補を作らない', async () => {
    const trials = buildSuccessTrials();
    const initialFormula = formula([A, B, C, D, E]);
    initialFormula.combinationExpression = '#1 OR #2';
    trials[0] = trial({ kind: 'initial', formula: initialFormula, accepted: true, after: measurement({ fingerprint: 'fp-initial', totalHits: 5000 }) });
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBe('c');
    expect(event!.candidates).toEqual([]);
  });

  test('d: 1 語しか削除していない保留は対象外になる（dReasons=single-removal）', async () => {
    const trials = buildSuccessTrials();
    // held を A,B,C,D,E → A,B,C,D（1 語だけ削除）に差し替える。
    trials[1] = trial({
      kind: 'proposal', formula: formula([A, B, C, D]), held: true, accepted: false,
      before: measurement({ fingerprint: 'fp-initial', capturedPmids: ['p1'] }),
      after: measurement({ fingerprint: 'fp-held', capturedPmids: ['p1'] }),
      changes: { targetBlockId: '1', addedTermsCount: 0, replacedTermsCount: 0 },
    });
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBe('d');
    expect(event!.dReasons).toEqual(['single-removal']);
    expect(event!.candidates).toEqual([]);
  });

  test('d: 語の追加・置換が混じった保留は対象外になる（dReasons=changes-mixed）', async () => {
    const trials = buildSuccessTrials();
    trials[1] = trial({
      kind: 'proposal', formula: formula([A, B, C]), held: true, accepted: false,
      before: measurement({ fingerprint: 'fp-initial', capturedPmids: ['p1'] }),
      after: measurement({ fingerprint: 'fp-held', capturedPmids: ['p1'] }),
      // D, E を削除しつつ、新語も 1 つ追加している（addedTermsCount > 0）。
      changes: { targetBlockId: '1', addedTermsCount: 1, replacedTermsCount: 0 },
    });
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBe('d');
    expect(event!.dReasons).toEqual(['changes-mixed']);
    expect(event!.candidates).toEqual([]);
  });

  test('d: 該当する held 試行が 1 件も無ければ dReasons=no-held', async () => {
    const trials = buildSuccessTrials();
    // held を持つ trials[1] を、held ではない普通の proposal に差し替える。
    trials[1] = trial({ kind: 'proposal', formula: formula([A, B, C]), held: false, accepted: false });
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBe('d');
    expect(event!.dReasons).toEqual(['no-held']);
    expect(event!.candidates).toEqual([]);
  });

  test('d: before.fingerprint が best と一致しなければ dReasons=fingerprint-mismatch', async () => {
    const trials = buildSuccessTrials();
    trials[1] = trial({
      kind: 'proposal', formula: formula([A, B, C]), held: true, accepted: false,
      // fp-initial ではなく別の fingerprint を指しているため、現在の best を指していない。
      before: measurement({ fingerprint: 'fp-別の式', capturedPmids: ['p1'] }),
      after: measurement({ fingerprint: 'fp-held', capturedPmids: ['p1'] }),
      changes: { targetBlockId: '1', addedTermsCount: 0, replacedTermsCount: 0 },
    });
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBe('d');
    expect(event!.dReasons).toEqual(['fingerprint-mismatch']);
    expect(event!.candidates).toEqual([]);
  });

  test('d: 対象ブロックに入れ子 AND があり OR-only でなければ dReasons=not-or-only', async () => {
    const trials = buildSuccessTrials();
    // ブロック #1 に (D AND E) という入れ子の AND を混ぜる。トップレベルは OR だが
    // expressionToOperatorSyntax はフラットに AND の有無を見るため OR-only ではないと判定される。
    const nestedFormula: PubmedFormula = {
      blocks: [
        { id: '1', expression: `(${A} OR ${B} OR ${C} OR (${D} AND ${E}))`, isCombination: false },
        { id: '2', expression: '"X"[tiab]', isCombination: false },
        { id: '3', expression: '#1 AND #2', isCombination: true },
      ],
      combinationExpression: '#1 AND #2',
    };
    trials[0] = trial({
      kind: 'initial', formula: nestedFormula, accepted: true,
      after: measurement({ fingerprint: 'fp-initial', totalHits: 5000 }),
    });
    trials[1] = trial({
      kind: 'proposal', formula: formula([A, B, C]), held: true, accepted: false,
      before: measurement({ fingerprint: 'fp-initial', capturedPmids: ['p1'] }),
      after: measurement({ fingerprint: 'fp-held', capturedPmids: ['p1'] }),
      changes: { targetBlockId: '1', addedTermsCount: 0, replacedTermsCount: 0 },
    });
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBe('d');
    expect(event!.dReasons).toEqual(['not-or-only']);
    expect(event!.candidates).toEqual([]);
  });

  test('e: 作った候補がすべて評価済みの式と一致すれば 0 件になる', async () => {
    // best は A,B,C の 3 語。held は A,B を削除して C だけを残す（2 語削除で条件を満たす）。
    const bestFormula = formula([A, B, C]);
    const heldFormula = formula([C]);
    const initialMeasurement = measurement({ fingerprint: 'fp-initial', totalHits: 5000 });
    const trials: Trial[] = [
      trial({ kind: 'initial', formula: bestFormula, accepted: true, after: initialMeasurement }),
      trial({
        kind: 'proposal', formula: heldFormula, held: true, accepted: false,
        before: measurement({ fingerprint: 'fp-initial', capturedPmids: ['p1'] }),
        after: measurement({ fingerprint: 'fp-held', capturedPmids: ['p1'] }),
        changes: { targetBlockId: '1', addedTermsCount: 0, replacedTermsCount: 0 },
      }),
      // A だけ削除した式、B だけ削除した式を、AI が既にどこかで提案済みだったことにする
      // （測定が成功していないと本体の `seen` には登録されないため、after を明示する）。
      trial({ kind: 'proposal', formula: formula([B, C]), accepted: false, after: measurement({ fingerprint: 'fp-remove-a' }) }),
      trial({ kind: 'proposal', formula: formula([A, C]), accepted: false, after: measurement({ fingerprint: 'fp-remove-b' }) }),
      trial({ kind: 'proposal', formula: formula(['"Z"[tiab]']), accepted: false, resubmissionRequested: true }),
      trial({ kind: 'proposal', formula: heldFormula, accepted: false, duplicateOf: 'candidate-2' }),
    ];
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBe('e');
    expect(event!.candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// best の terms は同じ fingerprint の別試行から補える
// ---------------------------------------------------------------------------

describe('best の terms は同じ fingerprint の別試行から補える', () => {
  test('initial.after に terms が無くても、同じ fingerprint を持つ後続試行の before.terms から引ける', async () => {
    const trials = buildSuccessTrials();
    // trials[0].after（initial の測定）には terms が無い（buildSuccessTrials のデフォルトどおり）。
    // 一方、trials[2]（差し戻しの引き金になった提案）の before は同じ fingerprint 'fp-initial' を
    // 指しつつ、語別測定（terms）を持っている、という実データの状況を再現する。
    trials[2] = trial({
      kind: 'proposal', formula: formula(['"Z"[tiab]']), accepted: false, resubmissionRequested: true,
      before: measurement({
        fingerprint: 'fp-initial',
        terms: [{ blockId: '1', query: D, finalContribution: 50 }, { blockId: '1', query: E, finalContribution: 0 }],
      }),
    });
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBeNull();
    expect(event!.best.measurement.terms).toBeDefined();
    expect(classifyContribution(event!.best, '1', D)).toBe('1〜100件');
    expect(classifyContribution(event!.best, '1', E)).toBe('0件');
  });

  test('どこにも terms が無ければ不明のまま（0 に補完しない）', async () => {
    const trials = buildSuccessTrials();
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBeNull();
    expect(event!.best.measurement.terms).toBeUndefined();
    expect(classifyContribution(event!.best, '1', D)).toBe('不明');
  });
});

// ---------------------------------------------------------------------------
// 条件 e は eventIndex より前の試行だけを「評価済み」とする
// ---------------------------------------------------------------------------

describe('条件 e は未来の試行を評価済みに含めない', () => {
  test('重複イベントより後に同じ候補を提案した試行があっても、候補から除外されない', async () => {
    const trials = buildSuccessTrials();
    // イベント（trials[3] の重複）より後ろに、候補の 1 つ（D だけ削除した式）と全く同じ formula の
    // proposal を追加する。run 全体を「評価済み」として集めてしまうと、この未来の試行のせいで
    // D を削除した候補が「既に評価済み」と誤判定される。
    trials.push(trial({ kind: 'proposal', formula: formula([A, B, C, E]), accepted: false }));
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBeNull();
    expect(event!.candidates.map((c) => c.removedTerm).sort()).toEqual([D, E].sort());
  });
});

// ---------------------------------------------------------------------------
// bucket 分類と selfResubmissionRequested
// ---------------------------------------------------------------------------

describe('bucket 分類と selfResubmissionRequested', () => {
  test('直前が差し戻しでない重複は no-resubmission バケットになる', async () => {
    const trials = [
      trial({ kind: 'initial', formula: formula([A, B, C]), accepted: true, after: measurement({ fingerprint: 'fp-initial' }) }),
      trial({ kind: 'proposal', formula: formula([A, B, C]), accepted: false, duplicateOf: 'x', resubmissionRequested: true }),
    ];
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.bucket).toBe('no-resubmission');
    expect(event!.selfResubmissionRequested).toBe(true);
  });

  test('重複トリガーが自らは差し戻しを要求していなければ selfResubmissionRequested=false', async () => {
    const trials = [
      trial({ kind: 'initial', formula: formula([A, B, C]), accepted: true, after: measurement({ fingerprint: 'fp-initial' }) }),
      trial({ kind: 'proposal', formula: formula([A, B, C]), accepted: false, duplicateOf: 'x' }),
    ];
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.bucket).toBe('no-resubmission');
    expect(event!.selfResubmissionRequested).toBe(false);
  });

  test('直前が差し戻し（resubmissionRequested）だった重複は resubmission バケット（再重複）になる', async () => {
    const trials = [
      trial({ kind: 'initial', formula: formula([A, B, C]), accepted: true, after: measurement({ fingerprint: 'fp-initial' }) }),
      trial({ kind: 'proposal', formula: formula(['"Z"[tiab]']), accepted: false, resubmissionRequested: true }),
      trial({ kind: 'proposal', formula: formula([A, B, C]), accepted: false, duplicateOf: 'x' }),
    ];
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.bucket).toBe('resubmission');
  });
});

// ---------------------------------------------------------------------------
// 第 3 節の合計は runId + fingerprint で重複排除する
// ---------------------------------------------------------------------------

describe('renderReport: 第 3 節の合計は重複排除する', () => {
  test('同じ run の同じ候補を 2 つのバケットで参照していても、合計欄では 1 件と数える', () => {
    const bestFormula = formula([A, B, C]);
    const best = {
      formula: bestFormula,
      measurement: measurement({ fingerprint: 'fp-best', terms: [{ blockId: '1', query: D, finalContribution: 5 }] }),
    };
    const sharedCandidate = { blockId: '1', removedTerm: D, fingerprint: 'fp-candidate-shared' };
    const eventReDuplication: DuplicationEvent = {
      runId: 'run-x', runLabel: 'label-x', trialIndex: 4, bucket: 'resubmission',
      selfResubmissionRequested: false, best, failedAt: null, dReasons: [], candidates: [sharedCandidate],
    };
    const eventFirstDetection: DuplicationEvent = {
      runId: 'run-x', runLabel: 'label-x', trialIndex: 3, bucket: 'no-resubmission',
      selfResubmissionRequested: true, best, failedAt: null, dReasons: [], candidates: [sharedCandidate],
    };
    const report: Report = { section1: [], events: [eventReDuplication, eventFirstDetection], skippedFileCount: 0 };
    const text = renderReport(report);
    expect(text).toContain('再重複からの候補（延べ数）（1 件）');
    expect(text).toContain('初回の重複からの候補（延べ数）（1 件）');
    expect(text).toContain('合計（重複排除）（1 件）');
    // 重複排除前なら 2 件のはずなので、素の合計ではないことも確認する。
    expect(text).not.toContain('合計（重複排除）（2 件）');
  });

  test('差し戻しを経ずに直接計上された重複が 0 件のときは、その旨が読める', () => {
    const report: Report = { section1: [], events: [], skippedFileCount: 0 };
    const text = renderReport(report);
    expect(text).toContain('差し戻しを経ずに改善なしへ直接計上された重複（この試行自体は resubmissionRequested を立てていない）（0 件）');
    expect(text).toContain('該当なし');
  });
});

// ---------------------------------------------------------------------------
// measurement の totalHits/capturedPmids/missedPmids は測定失敗で null になりうる
// ---------------------------------------------------------------------------

describe('測定不足（totalHits/capturedPmids/missedPmids が null）', () => {
  test('best の測定が null フィールドを含んでいても例外にならず、measurement-insufficient として扱う', async () => {
    const trials = buildSuccessTrials();
    trials[0] = trial({
      kind: 'initial', formula: formula([A, B, C, D, E]), accepted: true,
      after: { fingerprint: 'fp-initial', totalHits: null, capturedPmids: null, missedPmids: null },
    });
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBe('measurement-insufficient');
    expect(event!.candidates).toEqual([]);
  });

  test('一部のフィールドだけが null でも measurement-insufficient になる', async () => {
    const trials = buildSuccessTrials();
    trials[0] = trial({
      kind: 'initial', formula: formula([A, B, C, D, E]), accepted: true,
      after: { fingerprint: 'fp-initial', totalHits: 5000, capturedPmids: ['p1'], missedPmids: null },
    });
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBe('measurement-insufficient');
  });

  test('parseRunFile は null 測定を含む run.json を例外にせず読み取れる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-deletion-null-measurement-'));
    try {
      const raw = {
        runId: 'run-null-measurement', label: 'test-label', gitCommit: 'abc123', model: 'test-model', maxHits: 2000,
        optimization: {
          stopReason: 'no_improvement',
          trials: [{
            kind: 'initial', formula: formula([A, B, C]),
            after: { fingerprint: 'fp-1', totalHits: null, capturedPmids: null, missedPmids: null },
          }],
        },
      };
      const path = join(dir, 'run.json');
      writeFileSync(path, JSON.stringify(raw));
      const parsed = parseRunFile(path);
      expect(parsed).not.toBeNull();
      expect(parsed!.trials[0]!.after!.totalHits).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// label は省略可能（--label 未指定の eval:optimize 結果）
// ---------------------------------------------------------------------------

describe('ラベル省略時の扱い', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'partial-deletion-no-label-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function rawRunJsonWithoutLabel(): Record<string, unknown> {
    return {
      runId: 'no-label-run-1', gitCommit: 'abc123', model: 'test-model', maxHits: 2000,
      optimization: {
        stopReason: 'no_improvement',
        trials: [{
          kind: 'initial', formula: formula([A, B, C]),
          after: { fingerprint: 'fp-initial', totalHits: 100, capturedPmids: [], missedPmids: [] },
        }],
      },
    };
  }

  test('label の無い run.json も自動調整ログとして集計に入り、既定のラベル名を補う', async () => {
    writeFileSync(join(dir, 'run.json'), JSON.stringify(rawRunJsonWithoutLabel()));
    const report = await buildReport(dir);
    expect(report.skippedFileCount).toBe(0);
    expect(report.section1).toHaveLength(1);
    expect(report.section1[0]!.runCount).toBe(1);
    expect(report.section1[0]!.label).not.toBe('');
    // 既定のラベル名で --label 指定しても選び出せる。
    const filtered = await buildReport(dir, report.section1[0]!.label);
    expect(filtered.section1[0]!.runCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 評価済み集合は、測定・差集合の実測が成功した候補だけを含む（本体の seen 登録条件を再現）
// ---------------------------------------------------------------------------

describe('評価済み集合は測定・差集合が成功した候補だけを含む', () => {
  test('候補自身の測定が失敗（after が無い）していれば評価済みに数えず、同じ式を再度作れる', async () => {
    const trials = buildSuccessTrials();
    // D を削除した式を提案していたが、測定が失敗している（after が無い）。
    trials.splice(2, 0, trial({ kind: 'proposal', formula: formula([A, B, C, E]), accepted: false, after: null }));
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBeNull();
    expect(event!.candidates.map((c) => c.removedTerm).sort()).toEqual([D, E].sort());
  });

  test('候補自身の測定は成功していても、差集合の実測（impact）が失敗していれば評価済みに数えない', async () => {
    const trials = buildSuccessTrials();
    trials.splice(2, 0, trial({
      kind: 'proposal', formula: formula([A, B, C, E]), accepted: false,
      after: measurement({ fingerprint: 'fp-remove-d' }),
      impact: { lostHits: null, gainedHits: 5 },
    }));
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBeNull();
    expect(event!.candidates.map((c) => c.removedTerm)).toContain(D);
  });

  test('測定・差集合の実測がどちらも成功していれば評価済みに数え、同じ候補を除外する', async () => {
    const trials = buildSuccessTrials();
    trials.splice(2, 0, trial({
      kind: 'proposal', formula: formula([A, B, C, E]), accepted: false,
      after: measurement({ fingerprint: 'fp-remove-d' }),
      impact: { lostHits: 0, gainedHits: 5 },
    }));
    const [event] = await analyzeFeasibility([run({ trials })]);
    expect(event!.failedAt).toBeNull();
    expect(event!.candidates.map((c) => c.removedTerm)).not.toContain(D);
    expect(event!.candidates.map((c) => c.removedTerm)).toContain(E);
  });
});

// ---------------------------------------------------------------------------
// kind: 'information'（情報要求）は新案・却下に吸収しない
// ---------------------------------------------------------------------------

describe('差し戻し直後の情報要求（kind: information）', () => {
  test('直後が kind: information なら情報要求として分類し、新案には数えない', () => {
    const trials = [
      trial({ kind: 'proposal', resubmissionRequested: true }),
      trial({ kind: 'information' }),
    ];
    expect(classifyFollowUp(trials, 0)).toEqual({ kind: 'information' });
  });

  test('本当に未知の kind は proposal/rejected に吸収せず unknown として数える', () => {
    const trials = [
      trial({ kind: 'proposal', resubmissionRequested: true }),
      trial({ kind: 'some-future-kind' }),
    ];
    expect(classifyFollowUp(trials, 0)).toEqual({ kind: 'unknown', actualKind: 'some-future-kind' });
  });

  test('buildReport の第 1 節でも情報要求は新案・却下に数えず、独立した区分で数える', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-deletion-information-'));
    try {
      const raw = {
        runId: 'run-information-1', label: 'test-label', gitCommit: 'abc123', model: 'test-model', maxHits: 2000,
        optimization: {
          stopReason: 'no_improvement',
          trials: [
            {
              kind: 'initial', formula: formula([A, B, C]),
              after: { fingerprint: 'fp-initial', totalHits: 100, capturedPmids: [], missedPmids: [] },
            },
            { kind: 'proposal', formula: formula([A, B]), resubmissionRequested: true },
            { kind: 'information', formula: formula([A, B, C]) },
          ],
        },
      };
      writeFileSync(join(dir, 'run.json'), JSON.stringify(raw));
      const report = await buildReport(dir, 'test-label');
      const section = report.section1[0]!;
      expect(section.resubmissionCount).toBe(1);
      expect(section.followUp.information).toBe(1);
      expect(section.followUp.proposal.accepted + section.followUp.proposal.held + section.followUp.proposal.rejected).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 第 3 節: finalContribution の区分
// ---------------------------------------------------------------------------

describe('classifyContribution', () => {
  const dummyFormula = formula([A]);

  test('terms 自体が無ければ不明', () => {
    const best = { formula: dummyFormula, measurement: measurement({ terms: undefined }) };
    expect(classifyContribution(best, '1', D)).toBe('不明');
  });

  test('該当する語が terms に無ければ不明', () => {
    const best = { formula: dummyFormula, measurement: measurement({ terms: [{ blockId: '1', query: A, finalContribution: 10 }] }) };
    expect(classifyContribution(best, '1', D)).toBe('不明');
  });

  test('finalContribution が無い語は不明になり、0 に補完されない', () => {
    const best = { formula: dummyFormula, measurement: measurement({ terms: [{ blockId: '1', query: D }] }) };
    expect(classifyContribution(best, '1', D)).toBe('不明');
  });

  test.each([
    [0, '0件'],
    [1, '1〜100件'],
    [100, '1〜100件'],
    [101, '101〜1,000件'],
    [1000, '101〜1,000件'],
    [1001, '1,000件超'],
  ] as const)('finalContribution=%i は %s に分類される', (finalContribution, expected) => {
    const best = { formula: dummyFormula, measurement: measurement({ terms: [{ blockId: '1', query: D, finalContribution }] }) };
    expect(classifyContribution(best, '1', D)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// buildReport: runId による重複排除
// ---------------------------------------------------------------------------

describe('buildReport', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'partial-deletion-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function rawRunJson(): Record<string, unknown> {
    return {
      runId: 'dup-run-1',
      label: 'test-label',
      gitCommit: 'abc123',
      model: 'test-model',
      maxHits: 2000,
      optimization: {
        stopReason: 'no_improvement',
        trials: [
          {
            kind: 'initial',
            formula: formula([A, B, C]),
            accepted: true,
            after: { fingerprint: 'fp-initial', totalHits: 100, capturedPmids: [], missedPmids: [] },
          },
        ],
      },
    };
  }

  test('同じ runId の run.json が 2 箇所にあっても 1 run と数える', async () => {
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'a', 'run.json'), JSON.stringify(rawRunJson()));
    writeFileSync(join(dir, 'b', 'run.json'), JSON.stringify(rawRunJson()));
    const report = await buildReport(dir, 'test-label');
    expect(report.section1).toHaveLength(1);
    expect(report.section1[0]!.runCount).toBe(1);
    expect(report.section1[0]!.fileCount).toBe(2);
  });

  test('ディレクトリが無ければ例外', async () => {
    await expect(buildReport(join(dir, 'missing'))).rejects.toThrow('入力が存在しません');
  });
});
