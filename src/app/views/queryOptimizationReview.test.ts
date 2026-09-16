import { renderOptimizationReview } from './queryOptimizationReview';
import { createDraftView } from './draftView';
import { INITIAL_STATE, type QueryOptimizationRunState } from '../store';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';

function run(status: 'achieved' | 'needs_review' | 'stopped' | 'error'): QueryOptimizationRunState {
  const initial = parsePubmedFormulaMd('## PubMed/MEDLINE\n```\n#1 a[tiab] OR b[tiab]\n```');
  const formula = parsePubmedFormulaMd('## PubMed/MEDLINE\n```\n#1 a[tiab]\n```');
  const measurement = { id: 'm', fingerprint: 'fp', measuredAt: '2026-09-11', totalHits: 12,
    capturedPmids: ['1'], missedPmids: [], blocks: [] };
  return { status: 'ready', projectId: 'p', runId: 'r', maxHits: 20, maxIterations: 2,
    seedCount: 1, startedAtMs: 0, finishedAtMs: 1, stopRequested: false, error: null, meshContext: [],
    progress: { step: 'review', iterations: 1, bestTotalHits: 12, bestCapturedSeedCount: 1, trial: null },
    trials: [{ kind: 'initial', candidateId: 'initial', formula: initial, accepted: true,
      before: null, after: measurement, reason: '初期実測', rationale: '', apiEvents: [] }],
    result: { status, stopReason: 'conditions_met', unmetReasons: ['残った確認事項'], trials: [], iterations: 1, apiCalls: 1, elapsedMs: 1,
      best: { formula, measurement, evaluation: { status: 'success', fingerprint: 'fp', measuredAt: '2026-09-11',
        lineHits: [], seedPmids: ['1'], finalQuery: { status: 'success', error: null, finalQuery: 'a[tiab]',
          totalHits: 12, captureRate: 1, capturedPmids: ['1'], missedPmids: [] } } } },
  };
}
const actions = { adopt: jest.fn(async () => {}), edit: jest.fn(), blocks: jest.fn() };
beforeEach(() => { jest.clearAllMocks(); });

test('4区分と未確認事項を文字で表示し、捕捉の限界は1回だけ示す', () => {
  const container = document.createElement('div');
  renderOptimizationReview(container, run('achieved'), actions);
  expect(container.querySelectorAll('.optimization__review-section')).toHaveLength(4);
  expect(Array.from(container.querySelectorAll('h5')).map((node) => node.textContent)).toEqual([
    '確認済み：既知文献の捕捉', '確認済み：目安件数', '未確認：外側の確認', '確認済み：削除影響の確認',
  ]);
  expect(container.textContent).toContain('未確認事項');
  expect(container.textContent!.match(/既知シードを捕捉したことは、/g)).toHaveLength(1);
});

test('保存済み maybe が残る外側の確認は判定済み（残件あり）として未確認事項にも出す', () => {
  const current = run('achieved');
  current.outsideCheck = { status: 'ready', reason: null, originalHits: 12, marginHits: 1, evaluatedCount: 1,
    candidates: [{ pmid: '22', title: '外側の研究', year: 1990, abstract: null, source: 'outside', reason: '' }],
    decisions: { '22': { decision: 'maybe', status: 'saved', error: null } } };
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.querySelector('.optimization__review-section[data-state="decided"] h5')?.textContent)
    .toBe('判定済み（残件あり）：外側の確認');
  const heading = Array.from(container.querySelectorAll('h4')).find((node) => node.textContent === '未確認事項')!;
  expect(heading.nextElementSibling?.tagName).toBe('UL');
  expect(heading.nextElementSibling?.textContent).toContain('外側の確認:');
  expect(heading.nextElementSibling?.textContent).toContain('maybe で保存した候補 1 件は未確認として残ります');
  expect(container.textContent).not.toContain('未確認事項はありません');
});

test.each(['unjudged', 'saving', 'saved', 'error'] as const)('候補カードは判定 %s を再描画して操作状態を復元する', (status) => {
  const current = run('achieved');
  current.outsideCheck = { status: 'ready', reason: null, originalHits: 12, marginHits: 1, evaluatedCount: 1,
    candidates: [{ pmid: '22', title: '外側の研究', year: 1990, abstract: '抄録本文', source: 'outside', reason: 'AI の理由' }],
    decisions: status === 'unjudged' ? {} : { '22': { decision: 'include', status, error: status === 'error' ? '失敗' : null } } };
  const container = document.createElement('div');
  const decide = jest.fn(async () => {});
  const readjust = jest.fn(async () => {});
  for (let i = 0; i < 2; i += 1) {
    container.replaceChildren();
    renderOptimizationReview(container, current, { ...actions, decide, readjust });
    const card = container.querySelector('.optimization__candidate')!;
    expect(card.textContent).toContain('式の外側（AI が選んだ境界事例）');
    expect(card.textContent).toContain('AI の理由');
    expect(card.querySelector('details')?.textContent).toContain('抄録本文');
    expect(card.querySelector('details button')).toBeNull();
    expect(card.querySelector('a')?.href).toContain('22');
    expect(card.querySelector('[aria-live]')?.textContent).toContain(status === 'saving' ? '保存中' : status === 'saved' ? '保存済み' : status === 'error' ? '再試行' : '未判定');
    const button = card.querySelector('button')!;
    expect(button.disabled).toBe(status === 'saving' || status === 'saved');
    expect(button.getAttribute('aria-pressed')).toBe(String(status !== 'unjudged'));
    button.click();
    const retry = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'include した文献を保護して再調整する');
    expect(!!retry).toBe(status === 'saved');
    retry?.click();
  }
  expect(decide).toHaveBeenCalledTimes(status === 'saving' || status === 'saved' ? 0 : 2);
  expect(readjust).toHaveBeenCalledTimes(status === 'saved' ? 2 : 0);
});

test.each(['saving-decision', 'saving-formula', 'maybe', 'exclude'] as const)('再調整の制約: %s', (kind) => {
  const current = run('achieved');
  current.outsideCheck = { status: 'ready', reason: null, originalHits: 12, marginHits: 0, evaluatedCount: 0, candidates: [],
    decisions: { '22': { decision: kind === 'maybe' || kind === 'exclude' ? kind : 'include', status: 'saved', error: null } } };
  if (kind === 'saving-decision') current.outsideCheck.decisions['33'] = { decision: 'include', status: 'saving', error: null };
  if (kind === 'saving-formula') current.save = { status: 'saving', error: null, formulaVersionId: 'r' };
  const container = document.createElement('div');
  renderOptimizationReview(container, current, { ...actions, readjust: jest.fn(async () => {}) });
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'include した文献を保護して再調整する');
  if (kind === 'maybe' || kind === 'exclude') expect(button).toBeUndefined();
  else {
    expect(button!.disabled).toBe(true);
    expect(container.textContent).toContain('現在の最終候補は保存されません');
  }
});

test('失う文献は保留候補の由来だけを示し、AI の理由を表示しない', () => {
  const current = run('needs_review');
  current.outsideCheck = { status: 'error', reason: '探索失敗', originalHits: null, marginHits: null, evaluatedCount: 0,
    candidates: [{ pmid: '22', title: null, year: null, abstract: null, source: 'lost', reason: '表示しない', heldCandidateId: 'candidate-1' }], decisions: {} };
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.textContent).toContain('探索失敗');
  const card = container.querySelector('.optimization__candidate')!;
  expect(card.textContent).toContain('保留候補 candidate-1 で失う文献');
  expect(card.textContent).not.toContain('表示しない');
});

test.each([true, false])('診断の回収見込み %s に応じてブロック承認への導線を出す', (recoverableByTerms) => {
  const current = run('needs_review');
  current.result!.seedDiagnoses = [{ pmid: '22', title: '研究22', year: 2024, hasAbstract: true,
    meshHeadingCount: 12, blockingBlockIds: ['1'], recoverableByTerms, note: 'ブロック #1 が落としている。抄録あり・MeSH 12 件' }];
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.textContent).toContain('未捕捉シードの診断');
  expect(container.textContent).toContain(current.result!.seedDiagnoses[0]!.note);
  const link = container.querySelector('a')!;
  expect(link.textContent).toBe('PMID 22（2024）研究22');
  expect(link.parentElement!.childNodes).toHaveLength(1);
  expect(link.target).toBe('_blank');
  expect(link.rel).toBe('noopener noreferrer');
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'ブロック承認へ戻る');
  if (recoverableByTerms) expect(button).toBeUndefined();
  else {
    expect(container.textContent).toContain('語の調整では回収できないシードがあります。');
    button!.click();
    expect(actions.blocks).toHaveBeenCalledTimes(1);
    container.replaceChildren();
    renderOptimizationReview(container, current, { ...actions, blocks: undefined });
    expect(Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'ブロック承認へ戻る')!.disabled).toBe(true);
  }
});

test.each(['error', 'legacy'] as const)('診断未記録の %s では未捕捉なしと断定しない', (kind) => {
  const current = run('error');
  if (kind === 'error') {
    current.status = 'error';
    current.result = null;
  } else {
    current.result!.seedDiagnoses = undefined;
    current.result!.unmetReasons = ['未捕捉シード: 22'];
  }
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.textContent).toContain('未捕捉シードの診断は記録されていません');
  expect(container.textContent).not.toContain('未捕捉シードはありません');
  expect(container.textContent).not.toContain('語の調整では回収できないシードがあります');
  expect(container.textContent).not.toContain('ブロック承認へ戻る');
  if (kind === 'legacy') expect(container.textContent).toContain('未捕捉シード: 22');
});

test.each([0, 1])('診断なしでシード %s 件の説明を分ける', (seeds) => {
  const current = run('needs_review');
  current.result!.seedDiagnoses = [];
  current.result!.best!.evaluation.seedPmids = seeds ? ['1'] : [];
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.textContent).toContain(seeds ? '未捕捉シードはありません' : '検証対象シードがないため診断はありません');
});

test.each(['achieved', 'needs_review', 'stopped', 'error'] as const)('最終状態 %s でも保留の有無を表示する', (status) => {
  const current = run(status);
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.textContent).toContain('保留した候補はありません（採用した変更の失う集合はすべて 0 件）');
  current.trials.push({ ...current.trials[0]!, kind: 'proposal', candidateId: 'candidate-1', held: true, accepted: false });
  container.replaceChildren();
  renderOptimizationReview(container, current, actions);
  expect(container.textContent).toContain('保留した候補 1 件の削除影響の確認');
  expect(container.textContent).toContain('保留候補 candidate-1: 失う集合 未測定 件のうち書誌を確認できたのは先頭 0 件');
  current.trials.push({ ...current.trials[1]!, candidateId: 'candidate-2' });
  container.replaceChildren();
  renderOptimizationReview(container, current, actions);
  expect(container.textContent).toContain('保留した候補 2 件の削除影響の確認');
  expect(container.textContent).toContain('保留候補 candidate-2: 失う集合 未測定 件のうち書誌を確認できたのは先頭 0 件');
});

function heldTrialFixture(overrides: Record<string, unknown> = {}) {
  const formula = parsePubmedFormulaMd('## PubMed/MEDLINE\n```\n#1 a[tiab] OR c[tiab]\n```');
  return { kind: 'proposal' as const, candidateId: 'candidate-1', formula, accepted: false, held: true,
    reason: '失う集合のため保留', rationale: '', before: null, after: run('achieved').result!.best!.measurement, apiEvents: [],
    impact: { lostHits: 2, gainedHits: 1, error: null,
      inspected: [{ pmid: '2', title: null, year: null }, { pmid: '3', title: null, year: null }] },
    ...overrides };
}
function heldLostOutsideCheck() {
  return { status: 'ready' as const, reason: null, originalHits: 10, marginHits: 0, evaluatedCount: 0,
    candidates: ['2', '3'].map((pmid) => ({ pmid, title: null, year: null, abstract: null,
      source: 'lost' as const, heldCandidateId: 'candidate-1', reason: '' })),
    decisions: { '2': { decision: 'exclude' as const, status: 'saved' as const, error: null },
      '3': { decision: 'exclude' as const, status: 'saved' as const, error: null } } };
}

describe('保留候補の 3 操作（issue #172）', () => {
  test('最良候補が回収したシードを失う候補はボタンを無効化し PMID を表示する', () => {
    const current = run('needs_review');
    current.trials.push(heldTrialFixture());
    current.result!.best!.measurement.capturedPmids!.push('999');
    current.outsideCheck = heldLostOutsideCheck();
    const container = document.createElement('div');
    renderOptimizationReview(container, current, { ...actions, adoptHeld: jest.fn(async () => {}) });
    const card = container.querySelector('.optimization__held-candidate')!;
    expect(card.querySelector('button')!.disabled).toBe(true);
    expect(card.textContent).toContain('PMID: 999');
  });

  test('ゲートを満たせば採用ボタンが押せ、候補ごとの操作を呼び分ける', () => {
    const current = run('needs_review');
    current.trials.push(heldTrialFixture());
    current.outsideCheck = heldLostOutsideCheck();
    const adoptHeld = jest.fn(async () => {});
    const readjustHeld = jest.fn(async () => {});
    const rejectHeld = jest.fn();
    const container = document.createElement('div');
    renderOptimizationReview(container, current, { ...actions, adoptHeld, readjustHeld, rejectHeld });
    const card = container.querySelector('.optimization__held-candidate')!;
    expect(card.textContent).toContain('失う 2 件・増える 1 件・判定済み 2 件・未確認 0 件');
    const buttons = Array.from(card.querySelectorAll('button'));
    const adoptButton = buttons.find((b) => b.textContent === 'この候補を採用して保存')!;
    expect(adoptButton.disabled).toBe(false);
    const bestButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent === '採用して保存');
    expect(bestButtons).toHaveLength(1);
    expect(bestButtons[0]!.closest('.optimization__held-candidate')).toBeNull();
    adoptButton.click();
    expect(adoptHeld).toHaveBeenCalledWith('candidate-1');
    buttons.find((b) => b.textContent === 'これを初期式に再調整')!.click();
    expect(readjustHeld).toHaveBeenCalledWith('candidate-1');
    buttons.find((b) => b.textContent === '除外')!.click();
    expect(rejectHeld).toHaveBeenCalledWith('candidate-1');
  });

  test('ゲート未達なら採用ボタンを無効化し、あと何件必要かを表示する', () => {
    const current = run('needs_review');
    current.trials.push(heldTrialFixture({ impact: { lostHits: 50, gainedHits: 1, error: null,
      inspected: [{ pmid: '2', title: null, year: null }] } }));
    const container = document.createElement('div');
    renderOptimizationReview(container, current, { ...actions, adoptHeld: jest.fn(async () => {}) });
    const card = container.querySelector('.optimization__held-candidate')!;
    const adoptButton = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'この候補を採用して保存')!;
    expect(adoptButton.disabled).toBe(true);
    expect(card.textContent).toContain('あと 50 件の確認が必要です');
  });

  test('除外済みは「除外を取り消す」に変わり、採用・再調整ができなくなる', () => {
    const current = run('needs_review');
    current.trials.push(heldTrialFixture());
    current.outsideCheck = heldLostOutsideCheck();
    current.heldRejections = { 'candidate-1': { rejectedAt: '2026-09-12T00:00:00Z' } };
    const undoRejectHeld = jest.fn();
    const container = document.createElement('div');
    renderOptimizationReview(container, current, { ...actions, adoptHeld: jest.fn(async () => {}),
      readjustHeld: jest.fn(async () => {}), undoRejectHeld });
    const card = container.querySelector('.optimization__held-candidate')!;
    const cardButtons = Array.from(card.querySelectorAll('button'));
    expect(cardButtons.find((b) => b.textContent === 'この候補を採用して保存')!.disabled).toBe(true);
    expect(cardButtons.find((b) => b.textContent === 'これを初期式に再調整')!.disabled).toBe(true);
    const undoButton = cardButtons.find((b) => b.textContent === '除外を取り消す')!;
    expect(undoButton.disabled).toBe(false);
    undoButton.click();
    expect(undoRejectHeld).toHaveBeenCalledWith('candidate-1');
    expect(card.textContent).toContain('人がこの変更を除外しました');
  });

  test('保留候補の採用は最良候補の保存と排他で、状態表示にどちらが保存されたか出す', () => {
    const current = run('needs_review');
    current.trials.push(heldTrialFixture());
    current.save = { formulaVersionId: 'r', status: 'saved', error: null, target: { kind: 'held', candidateId: 'candidate-1' } };
    const container = document.createElement('div');
    renderOptimizationReview(container, current, { ...actions, adoptHeld: jest.fn(async () => {}) });
    expect(container.querySelector('.optimization__save-status')?.textContent)
      .toContain('保留候補 candidate-1 の式を採用して保存しました');
    const heldCard = container.querySelector('.optimization__held-candidate')!;
    expect(Array.from(heldCard.querySelectorAll('button')).find((b) => b.textContent === 'この候補を採用して保存')!.disabled).toBe(true);
    const bottomButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.optimization__review-actions button'))
      .filter((b) => !b.closest('.optimization__held-candidate'));
    expect(bottomButtons.find((b) => b.textContent === '採用して保存')!.disabled).toBe(true);
  });
});

test.each([['achieved', '目安件数と既知シードの捕捉を満たしました'], ['needs_review', '要確認'], ['stopped', '停止'], ['error', 'エラー']] as const)(
  '%s を %s と区別し、最終式・上限・既知シード・正味の変更と懸念を出す', (status, label) => {
    const container = document.createElement('div');
    renderOptimizationReview(container, run(status), actions);
    expect(container.querySelector('h3')?.textContent).toBe(`最終レビュー：${label}`);
    expect(container.querySelector('pre')?.textContent).toContain('#1 a[tiab]');
    expect(container.textContent).toContain('目安件数 20 件に対して実測 12 件（目安以下）');
    expect(container.textContent).toContain('既知シード 1/1 件捕捉');
    if (status === 'achieved') {
      expect(container.querySelector('h3')?.nextElementSibling?.textContent).toBe('既知シードを捕捉したことは、未知の適格研究を網羅したことを意味しません。');
      expect(container.textContent).not.toContain('既知シードの捕捉は、');
    } else expect(container.textContent).toContain('未知の適格研究の網羅性を保証するものではありません');
    expect(container.textContent).toContain('#1: a[tiab] OR b[tiab] → a[tiab]');
    expect(container.textContent).toContain('残った確認事項');
    expect(container.querySelector('details')).toBeNull();
  }
);

test('実測候補がないエラーでは保存・編集を無効化し、未測定を 0 にしない', () => {
  const current = run('error');
  current.result = null;
  current.status = 'error';
  current.error = '初期式の準備に失敗';
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.textContent).toContain('実測 未測定');
  expect(container.textContent).toContain('初期式の準備に失敗');
  expect(Array.from(container.querySelectorAll('button')).every((button) => button.disabled)).toBe(true);
});

test.each(['saving', 'saved', 'error'] as const)('保存状態 %s をライブ行に保持し、操作を制御する', (status) => {
  const current = run('achieved');
  current.save = { formulaVersionId: 'r', status, error: status === 'error' ? '保存失敗' : null };
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.querySelector('button')?.disabled).toBe(status !== 'error');
  expect(container.querySelector('.optimization__save-status')?.getAttribute('aria-live')).toBe('polite');
  expect(container.querySelector('.optimization__save-error')?.textContent).toBe(status === 'error' ? '保存失敗' : '');
});

test('最終レビューと保存の再描画で既存の履歴 DOM・詳細の開閉を保持する', () => {
  const render = createDraftView();
  const current = run('achieved');
  const state = { ...INITIAL_STATE, project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: '研究' },
    blocksDraft: { blocks: [{ blockLabel: '疾患', description: '', aiGenerated: false, note: '' }], combinationExpression: '#1' },
    queryOptimizationRun: current };
  const container = document.createElement('div');
  const context = { state, navigate: jest.fn() };
  render(container, context);
  const history = container.querySelector('.optimization__history');
  const details = history!.querySelector('details')!;
  details.open = true;
  current.save = { formulaVersionId: 'r', status: 'saved', error: null };
  render(container, context);
  expect(container.querySelector('.optimization__history')).toBe(history);
  expect(details.open).toBe(true);
  expect(container.querySelectorAll('.optimization__review')).toHaveLength(1);
  expect(container.querySelector('.optimization__save-status')?.textContent).toContain('保存しました');
});

test.each([false, true])('診断の小見出し・削減率・未判定理由を参考情報として表示する（旧データ: %s）', (legacy) => {
  const current = run('needs_review');
  if (!legacy) current.result!.blockDiagnosis = { fingerprint: 'fp', note: '', overlaps: [
    { blockIds: ['1', '2'], kind: 'same', terms: [], qualified: false, note: '#1 と #2: 同じ MeSH "Disease"[Mesh]' },
  ], narrowing: [
    { blockId: '1', label: '疾患', finalHits: 90, withoutHits: 100, reduction: 0.1, ineffective: true, note: '' },
    { blockId: '2', label: '治療', finalHits: 90, withoutHits: null, reduction: null, ineffective: null, note: '未判定: 階層を取得できなかった' },
  ] };
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  expect(container.querySelectorAll('.optimization__review-section')).toHaveLength(4);
  if (legacy) expect(container.textContent).not.toContain('ブロック構造の診断');
  else for (const text of ['ブロック構造の診断', '#1 と #2', '削減率 10.0%', '未判定: 階層を取得できなかった']) expect(container.textContent).toContain(text);
});

test('初期生成の通知を最終式の前に同じ文言と一覧順で表示する', () => {
  const current = run('achieved');
  current.generationNotices = {
    filterNotice: '研究デザインに RCT 以外を含むため RCT フィルタを付けませんでした',
    parenthesizedTerms: [{ blockIndex: 0, blockId: '1', blockLabel: '疾患', term: 'a AND b' }],
    removedMeshHeadings: [{ blockIndex: 0, blockId: '1', blockLabel: '疾患', descriptor: 'Unknown' }],
    replacedMeshHeadings: [{ blockIndex: 0, blockId: '1', blockLabel: '疾患', from: '旧見出し', to: ['正式見出し'] }],
  };
  const container = document.createElement('div');
  renderOptimizationReview(container, current, actions);
  const notice = container.querySelector('.draft__mesh-notice')!;
  expect(notice.previousElementSibling?.textContent).toBe('初期式の生成で行った変更');
  expect(notice.nextElementSibling?.textContent).toBe('最終式');
  expect(Array.from(notice.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
    '#1 疾患: 旧見出し → 正式見出し', '#1 疾患: Unknown', '#1 疾患: (a AND b)',
  ]);
  expect(notice.textContent).toContain(current.generationNotices.filterNotice);
  expect(notice.textContent).toContain('MeSH の同義語を正式な見出しに置き換えました');
  expect(notice.textContent).toContain('検索語の中の AND / OR を括弧で囲みました');
});

test.each([undefined, { filterNotice: null, parenthesizedTerms: [], removedMeshHeadings: [], replacedMeshHeadings: [] }])(
  '初期生成の通知が無いか空なら見出しも通知も表示しない（%j）', (generationNotices) => {
    const container = document.createElement('div');
    renderOptimizationReview(container, { ...run('achieved'), generationNotices }, actions);
    expect(container.querySelector('.draft__mesh-notice')).toBeNull();
    expect(container.textContent).not.toContain('初期式の生成で行った変更');
  }
);
