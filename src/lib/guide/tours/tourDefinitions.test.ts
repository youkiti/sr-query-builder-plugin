import { GUIDE_TOURS, type GuideTourId, type TourStep } from './index';
import { availableTours, isTourUnavailable, nextStepIndex, shouldAdvance } from '../tourProgress';

function step(id: GuideTourId, stepId: string): TourStep {
  const found = GUIDE_TOURS[id].steps.find(item => item.id === stepId);
  if (!found) throw new Error(`手順が無い: ${id}/${stepId}`);
  return found;
}

function ids(id: GuideTourId): string[] {
  return GUIDE_TOURS[id].steps.map(item => item.id);
}

describe('全ツアー共通の決まり', () => {
  test('4 本とも中身があり、一覧に出る（枠のままではない）', () => {
    expect(availableTours().map(tour => tour.id)).toEqual(
      ['getting-started', 'draft-and-optimize', 'expand-seeds', 'edit-and-export'],
    );
  });

  test('ビューが JS で作る要素を指す手順には dynamicTarget があり、サイドバー・ヘッダーを指す手順には無い', () => {
    for (const tour of Object.values(GUIDE_TOURS)) {
      for (const item of tour.steps) {
        const fixed = item.target === 'nav' || item.target === 'tour-list' || item.target.startsWith('nav-');
        expect([tour.id, item.id, item.dynamicTarget === true]).toEqual([tour.id, item.id, !fixed]);
      }
    }
  });

  test('画面を開く手順は nav-<ルート> を指し、route-opened-<ルート> で進む', () => {
    for (const tour of Object.values(GUIDE_TOURS)) {
      for (const item of tour.steps.filter(candidate => candidate.id.startsWith('open-'))) {
        const route = item.target.replace(/^nav-/, '');
        expect([tour.id, item.id, item.target.startsWith('nav-')]).toEqual([tour.id, item.id, true]);
        expect(item.advance).toEqual({ type: 'events', events: [`route-opened-${route}`] });
      }
    }
  });

  test('費用がかかる・保存する操作を押す手順は optional で、押さずに次へ進める', () => {
    const optional: Array<[GuideTourId, string]> = [
      ['getting-started', 'enter-protocol'], ['getting-started', 'approve-blocks'],
      ['draft-and-optimize', 'optimize-start'], ['expand-seeds', 'fetch-candidates'],
      ['edit-and-export', 'save-version'],
    ];
    for (const [tourId, stepId] of optional) {
      const advance = step(tourId, stepId).advance;
      expect([tourId, stepId, advance.type === 'events' && advance.optional === true]).toEqual([tourId, stepId, true]);
    }
    // 状態に痕跡が残らない変換の実行は、完了では進めず「次へ」で進む。
    expect(step('edit-and-export', 'run-export').advance).toEqual({ type: 'next' });
  });

  test('サイドバーを指す手順と finish は、画面（route）を問わない', () => {
    for (const tour of Object.values(GUIDE_TOURS)) {
      for (const item of tour.steps) {
        if (item.target.startsWith('nav-') || item.id === 'finish') expect(item.route).toBeUndefined();
      }
    }
  });
});

describe('はじめての流れ', () => {
  test('手順の並びと、既存の手順 ID', () => {
    expect(ids('getting-started')).toEqual([
      'welcome', 'open-protocol', 'enter-protocol', 'open-blocks', 'review-blocks', 'review-filters',
      'approve-blocks', 'open-seeds', 'add-seeds', 'finish',
    ]);
    expect(GUIDE_TOURS['getting-started'].unavailableIf).toBeUndefined();
  });

  test('プロトコルが入っていればプロトコル入力の 2 手順を飛ばし、承認済みなら承認の手順を飛ばす', () => {
    expect(step('getting-started', 'open-protocol').skipIf).toBe('has-protocol');
    expect(step('getting-started', 'enter-protocol').skipIf).toBe('has-protocol');
    expect(step('getting-started', 'approve-blocks').skipIf).toBe('blocks-approved');
    const tour = GUIDE_TOURS['getting-started'];
    expect(nextStepIndex(tour, 1, { 'has-protocol': true })).toBe(3);
    expect(nextStepIndex(tour, 6, { 'blocks-approved': true })).toBe(7);
    expect(nextStepIndex(tour, 1, {})).toBe(1);
  });

  test('プロトコルの解析とブロックの承認が、それぞれのイベントで進む', () => {
    expect(shouldAdvance(step('getting-started', 'enter-protocol'), 'protocol-analyzed')).toBe(true);
    expect(shouldAdvance(step('getting-started', 'enter-protocol'), 'blocks-approved')).toBe(false);
    expect(shouldAdvance(step('getting-started', 'approve-blocks'), 'blocks-approved')).toBe(true);
  });

  test('シード論文の登録欄は、説明だけで押させない（次へで進む）', () => {
    expect(step('getting-started', 'add-seeds').advance).toEqual({ type: 'next' });
  });
});

describe('検索式の作成と自動調整', () => {
  test('手順の並びと、#/draft を開けないときは使えない', () => {
    expect(ids('draft-and-optimize')).toEqual([
      'open-draft', 'optimize-settings', 'optimize-start', 'optimize-history', 'optimize-review',
      'held-candidates', 'revalidate', 'finish',
    ]);
    const tour = GUIDE_TOURS['draft-and-optimize'];
    expect(tour.unavailableIf).toBe('draft-unavailable');
    expect(isTourUnavailable(tour, { 'draft-unavailable': true })).toBe(true);
    expect(isTourUnavailable(tour, { 'draft-unavailable': false })).toBe(false);
  });

  test('開始は自動調整の開始イベントで進み、保留候補の手順は対象を押せなくして次へで進める', () => {
    expect(shouldAdvance(step('draft-and-optimize', 'optimize-start'), 'optimization-started')).toBe(true);
    const held = step('draft-and-optimize', 'held-candidates');
    expect(held.blockTarget).toBe(true);
    expect(held.advance).toEqual({ type: 'next' });
    for (const item of GUIDE_TOURS['draft-and-optimize'].steps) {
      if (item.id !== 'held-candidates') expect(item.blockTarget).toBeUndefined();
    }
  });

  test('実行しないと現れない手順（履歴・最終レビュー・保留候補・補助操作）は、次へで先へ進める', () => {
    for (const stepId of ['optimize-history', 'optimize-review', 'held-candidates', 'revalidate']) {
      expect(step('draft-and-optimize', stepId).advance).toEqual({ type: 'next' });
    }
  });
});

describe('シードの拡張', () => {
  test('手順の並びと、#/expand を開けないときは使えない', () => {
    expect(ids('expand-seeds')).toEqual(['open-expand', 'fetch-candidates', 'judge-candidates', 'update-proposals', 'finish']);
    const tour = GUIDE_TOURS['expand-seeds'];
    expect(tour.unavailableIf).toBe('expand-unavailable');
    expect(isTourUnavailable(tour, { 'expand-unavailable': true })).toBe(true);
  });

  test('取得は候補の取得イベントで進み、判定・更新提案は次へで進める', () => {
    expect(shouldAdvance(step('expand-seeds', 'fetch-candidates'), 'expand-candidates-fetched')).toBe(true);
    expect(step('expand-seeds', 'judge-candidates').advance).toEqual({ type: 'next' });
    expect(step('expand-seeds', 'update-proposals').advance).toEqual({ type: 'next' });
  });
});

describe('編集と書き出し', () => {
  test('手順の並びと、#/edit を開けないときは使えない', () => {
    expect(ids('edit-and-export')).toEqual([
      'open-edit', 'edit-blocks', 'inspect-block', 'save-version', 'open-export', 'run-export',
      'convert-databases', 'finish',
    ]);
    const tour = GUIDE_TOURS['edit-and-export'];
    expect(tour.unavailableIf).toBe('edit-unavailable');
    expect(isTourUnavailable(tour, { 'edit-unavailable': true })).toBe(true);
  });

  test('保存は保存完了のイベントで進み、変換結果は実行の後に置く（結果は実行しないと現れない）', () => {
    expect(shouldAdvance(step('edit-and-export', 'save-version'), 'formula-saved')).toBe(true);
    const list = ids('edit-and-export');
    expect(list.indexOf('run-export')).toBeLessThan(list.indexOf('convert-databases'));
  });
});
