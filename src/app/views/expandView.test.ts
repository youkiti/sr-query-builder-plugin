import type { BoundaryCasesResult, ValidationSummary } from '@/app/services';
import { INITIAL_STATE, type AppState, type ExpandRunState } from '../store';
import { createExpandView } from './expandView';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

const stateReady: AppState = {
  ...INITIAL_STATE,
  project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
  currentFormulaVersionId: 'v1',
  currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n#1 x\n```\n',
};

function sampleResult(overrides: Partial<BoundaryCasesResult> = {}): BoundaryCasesResult {
  return {
    mode: 'margin',
    candidates: [
      {
        pmid: '111',
        title: 'Paper A',
        year: 2020,
        reason: 'subset',
        abstract: 'Body of A.',
        meshHeadings: [],
      },
      { pmid: '222', title: null, year: null, reason: '', abstract: null, meshHeadings: [] },
    ],
    originalHits: 500,
    broadenedHits: 700,
    marginHits: 200,
    evaluatedCount: 20,
    additions: [],
    ...overrides,
  };
}

/** status='ready'（取得完了）の expandRun を載せた state */
function readyState(result: BoundaryCasesResult = sampleResult()): AppState {
  const expandRun: ExpandRunState = {
    status: 'ready',
    step: 'done',
    startedAtMs: 0,
    error: null,
    result,
  };
  return { ...stateReady, expandRun };
}

/** status='running'（取得中）の expandRun を載せた state */
function runningState(
  step: ExpandRunState['step'] = 'esearch',
  startedAtMs = 0
): AppState {
  const expandRun: ExpandRunState = {
    status: 'running',
    step,
    startedAtMs,
    error: null,
    result: null,
  };
  return { ...stateReady, expandRun };
}

/** status='error' の expandRun を載せた state */
function errorState(message: string | null): AppState {
  const expandRun: ExpandRunState = {
    status: 'error',
    step: 'pick-boundary',
    startedAtMs: 0,
    error: message,
    result: null,
  };
  return { ...stateReady, expandRun };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function pressKey(target: HTMLElement, key: string): void {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
}

function buildValidationSummary(overrides: Partial<ValidationSummary> = {}): ValidationSummary {
  return {
    lineHits: [],
    finalQuery: {
      finalQuery: '#1',
      totalHits: 100,
      captureRate: 0.8,
      capturedPmids: ['111', '222', '333', '444'],
      missedPmids: ['555'],
    },
    finalQueryError: null,
    mesh: [],
    meshFrequency: [],
    meshError: null,
    meshHierarchy: [],
    meshMermaid: 'flowchart TD\n  empty["(MeSH 階層なし)"]',
    meshHierarchyError: null,
    eligibleSeedCount: 5,
    totalSeedCount: 6,
    loggedValidationIds: [],
    ...overrides,
  };
}

describe('createExpandView', () => {
  describe('ガード表示', () => {
    test('プロジェクト未選択時は警告のみ', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, { state: INITIAL_STATE, navigate: jest.fn() });
      expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
      expect(container.querySelector('.expand__actions')).toBeNull();
    });

    test('検索式未生成時は /draft 誘導', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, {
        state: { ...stateReady, currentFormulaMarkdown: null },
        navigate: jest.fn(),
      });
      expect(container.querySelector('.view__placeholder')?.textContent).toContain('/draft');
    });
  });

  describe('取得トリガー', () => {
    test('取得ボタンで onFetch が呼ばれる', () => {
      const onFetch = jest.fn().mockResolvedValue(undefined);
      const view = createExpandView({ onFetch });
      const container = buildContainer();
      view(container, { state: stateReady, navigate: jest.fn() });
      const btn = container.querySelector<HTMLButtonElement>('.expand__actions button')!;
      expect(btn.textContent).toBe('境界事例を取得');
      btn.click();
      expect(onFetch).toHaveBeenCalledTimes(1);
      // 保険のローカル無効化
      expect(btn.disabled).toBe(true);
    });

    test('onFetch 未指定でもクリックで例外にならない', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, { state: stateReady, navigate: jest.fn() });
      const btn = container.querySelector<HTMLButtonElement>('.expand__actions button')!;
      expect(() => btn.click()).not.toThrow();
    });

    test('取得中はボタンが無効で、クリックしても onFetch は呼ばれない', () => {
      const onFetch = jest.fn().mockResolvedValue(undefined);
      const view = createExpandView({ onFetch });
      const container = buildContainer();
      view(container, { state: runningState(), navigate: jest.fn() });
      const btn = container.querySelector<HTMLButtonElement>('.expand__actions button')!;
      expect(btn.textContent).toBe('取得中…');
      expect(btn.disabled).toBe(true);
      btn.click();
      expect(onFetch).not.toHaveBeenCalled();
    });
  });

  describe('進捗トラッカー（取得中）', () => {
    test('6 段階のチップを done / active / pending で描画する', () => {
      const view = createExpandView();
      const container = buildContainer();
      // dedup（index 3）実行中: protocol/broaden/esearch=done, dedup=active, efetch/pick-boundary=pending
      view(container, { state: runningState('dedup'), navigate: jest.fn() });
      const tracker = container.querySelector('.expand__tracker');
      expect(tracker).not.toBeNull();
      const chips = container.querySelectorAll('.draft__step');
      expect(chips).toHaveLength(6);
      expect(chips[0]?.classList.contains('draft__step--done')).toBe(true);
      expect(chips[1]?.classList.contains('draft__step--done')).toBe(true);
      expect(chips[2]?.classList.contains('draft__step--done')).toBe(true);
      expect(chips[3]?.classList.contains('draft__step--active')).toBe(true);
      expect(chips[4]?.classList.contains('draft__step--pending')).toBe(true);
      expect(chips[5]?.classList.contains('draft__step--pending')).toBe(true);
      // プログレスバーとカウンタ
      const bar = container.querySelector<HTMLProgressElement>('.draft__progressbar')!;
      expect(bar.max).toBe(6);
      expect(bar.value).toBe(3);
      expect(container.querySelector('.draft__step-counter')?.textContent).toBe('ステップ 4 / 6');
    });

    test('ステータスに現在の段階と経過時間を表示する（経過が分を超える場合）', () => {
      const view = createExpandView();
      const container = buildContainer();
      // startedAtMs=0 なので経過は巨大 → 「分」を含む
      view(container, { state: runningState('pick-boundary', 0), navigate: jest.fn() });
      const status = container.querySelector('.expand__status')!;
      expect(status.textContent).toContain('[取得]');
      expect(status.textContent).toContain('AI が境界事例を選定中');
      expect(status.textContent).toContain('分');
    });

    test('経過が 1 分未満なら「秒」のみ表示する', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, { state: runningState('protocol', Date.now()), navigate: jest.fn() });
      const status = container.querySelector('.expand__status')!;
      expect(status.textContent).toContain('プロトコルを取得中');
      expect(status.textContent).toContain('秒');
      expect(status.textContent).not.toContain('分');
    });
  });

  describe('経過時間の自動更新ティッカー', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    test('1 秒ごとに更新し、要素が DOM から外れたら停止する', () => {
      // ticker は status.ownerDocument.defaultView の setInterval を使う。
      // createHTMLDocument 製の切り離し document は defaultView が null なので、
      // jsdom グローバル document（fake timers が効く）にコンテナを置く。
      const view = createExpandView();
      const container = document.createElement('div');
      document.body.appendChild(container);
      try {
        view(container, { state: runningState('esearch'), navigate: jest.fn() });
        const status = container.querySelector('.expand__status')!;
        jest.advanceTimersByTime(1000);
        expect(status.textContent).toContain('[取得]');
        // 再描画相当で要素を外すと、次の tick で interval が止まり例外にならない
        container.innerHTML = '';
        expect(() => jest.advanceTimersByTime(2000)).not.toThrow();
      } finally {
        container.remove();
      }
    });
  });

  describe('エラー表示', () => {
    test('expandRun が error ならメッセージを表示する', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, { state: errorState('NCBI down'), navigate: jest.fn() });
      expect(container.querySelector('.expand__error')?.textContent).toBe('NCBI down');
      // 候補は描画されない
      expect(container.querySelector('.expand__candidate')).toBeNull();
    });

    test('error メッセージが null なら「不明なエラー」を表示する', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, { state: errorState(null), navigate: jest.fn() });
      expect(container.querySelector('.expand__error')?.textContent).toBe('不明なエラー');
    });
  });

  describe('候補一覧（取得完了）', () => {
    test('expandRun が ready なら候補一覧と判定ボタンを描画する', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const items = container.querySelectorAll('.expand__candidate');
      expect(items).toHaveLength(2);
      expect(container.querySelector('.expand__status')?.textContent).toContain('2 件');
      expect(container.querySelector('.expand__status')?.textContent).toContain('現式 500 件');
      expect(container.querySelector('.expand__status')?.textContent).toContain('外側 200 件');
      expect(container.querySelector('.expand__status')?.textContent).toContain('評価 20 件');
      // 1 つ目は title あり・理由あり
      expect(items[0]?.querySelector('.expand__candidate-meta')?.textContent).toContain('Paper A');
      expect(items[0]?.querySelector('.expand__candidate-meta')?.textContent).toContain('(2020)');
      expect(items[0]?.querySelector('.expand__candidate-reason')?.textContent).toContain('subset');
      // 2 つ目は title null → (no title)、year null → (-)、reason '' → (無し)
      expect(items[1]?.querySelector('.expand__candidate-meta')?.textContent).toContain('(no title)');
      expect(items[1]?.querySelector('.expand__candidate-meta')?.textContent).toContain('(-)');
      expect(items[1]?.querySelector('.expand__candidate-reason')?.textContent).toContain('(無し)');
      // 各候補には 3 つの判定ボタン
      expect(items[0]?.querySelectorAll('button')).toHaveLength(3);
    });

    test('inside モードは初期シードバナーと内側ステータスを表示する', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ mode: 'inside', marginHits: 0, additions: [] })),
        navigate: jest.fn(),
      });
      expect(container.querySelector('.expand__inside-banner')).not.toBeNull();
      const status = container.querySelector('.expand__status')?.textContent ?? '';
      expect(status).toContain('初期シード候補');
      expect(status).toContain('式の内側 500 件');
      // 候補自体は通常どおり描画される
      expect(container.querySelectorAll('.expand__candidate')).toHaveLength(2);
    });

    test('inside モードで候補 0 件のときは内側用の空メッセージを出す', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, {
        state: readyState(
          sampleResult({ mode: 'inside', candidates: [], marginHits: 0, evaluatedCount: 0, additions: [] })
        ),
        navigate: jest.fn(),
      });
      expect(container.querySelector('.expand__status')?.textContent).toContain(
        'すべて既存 seed と重複'
      );
    });

    test('各候補にアブストラクト本文を描画し、無い場合はプレースホルダを出す', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const items = container.querySelectorAll('.expand__candidate');
      // 1 件目: abstract あり → 本文が入り、--empty は付かない
      const body0 = items[0]?.querySelector('.expand__candidate-abstract-body');
      expect(body0?.textContent).toBe('Body of A.');
      expect(body0?.classList.contains('expand__candidate-abstract-body--empty')).toBe(false);
      // 2 件目: abstract null → プレースホルダ + --empty
      const body1 = items[1]?.querySelector('.expand__candidate-abstract-body');
      expect(body1?.textContent).toContain('アブストラクトなし');
      expect(body1?.classList.contains('expand__candidate-abstract-body--empty')).toBe(true);
    });

    test('アブストラクト本文は textContent で代入され HTML はエスケープされる', () => {
      const view = createExpandView();
      const container = buildContainer();
      const malicious = '<img src=x onerror=alert(1)> & 結論';
      view(container, {
        state: readyState(
          sampleResult({
            candidates: [
              { pmid: '111', title: 'A', year: 2020, reason: 'r', abstract: malicious, meshHeadings: [] },
            ],
          })
        ),
        navigate: jest.fn(),
      });
      const body = container.querySelector('.expand__candidate-abstract-body')!;
      // テキストとしてそのまま入り、子要素（img）は生成されない
      expect(body.textContent).toBe(malicious);
      expect(body.querySelector('img')).toBeNull();
    });

    test('include ボタンで onDecide が呼ばれ、decided クラスが付く', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const item = container.querySelector<HTMLElement>('.expand__candidate')!;
      const includeBtn = item.querySelector<HTMLButtonElement>('button[data-decision=include]')!;
      includeBtn.click();
      await flushAsync();
      await flushAsync();
      expect(onDecide).toHaveBeenCalledWith({
        pmid: '111',
        title: 'Paper A',
        year: 2020,
        decision: 'include',
        reason: 'subset',
      });
      expect(item.classList.contains('expand__candidate--decided')).toBe(true);
      expect(item.querySelector('.expand__candidate-status')?.textContent).toContain('include');
    });

    test('onDecide が reject したら status を更新し、ボタンを再度有効化', async () => {
      const onDecide = jest.fn().mockRejectedValue(new Error('boom'));
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) })),
        navigate: jest.fn(),
      });
      const item = container.querySelector<HTMLElement>('.expand__candidate')!;
      const includeBtn = item.querySelector<HTMLButtonElement>('button[data-decision=include]')!;
      includeBtn.click();
      await flushAsync();
      await flushAsync();
      expect(item.querySelector('.expand__candidate-status')?.textContent).toContain('失敗');
      expect(includeBtn.disabled).toBe(false);
    });

    test('onDecide 未指定でもクリックで例外にならない', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const includeBtn = container.querySelector<HTMLButtonElement>(
        'button[data-decision=include]'
      )!;
      expect(() => includeBtn.click()).not.toThrow();
    });

    test('Error 以外の onDecide 例外も String 化される', async () => {
      const onDecide = jest.fn().mockRejectedValue('rare');
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) })),
        navigate: jest.fn(),
      });
      const includeBtn = container.querySelector<HTMLButtonElement>(
        'button[data-decision=include]'
      )!;
      includeBtn.click();
      await flushAsync();
      await flushAsync();
      expect(container.querySelector('.expand__candidate-status')?.textContent).toContain('rare');
    });

    test('候補描画時にフォーカス対象 li へ scrollIntoView が呼ばれる', () => {
      const scrollSpy = jest.fn();
      const proto = HTMLElement.prototype as unknown as {
        scrollIntoView?: (...args: unknown[]) => void;
      };
      const original = proto.scrollIntoView;
      proto.scrollIntoView = scrollSpy;
      try {
        const view = createExpandView();
        const container = buildContainer();
        view(container, { state: readyState(), navigate: jest.fn() });
        expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
      } finally {
        if (original === undefined) {
          delete proto.scrollIntoView;
        } else {
          proto.scrollIntoView = original;
        }
      }
    });
  });

  describe('キーボード操作', () => {
    test('"i" キーでフォーカス中の候補を include 判定できる', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(onDecide).toHaveBeenCalledTimes(1);
      expect(onDecide.mock.calls[0]![0]).toMatchObject({ pmid: '111', decision: 'include' });
    });

    test('保存中に同じショートカットを連打しても onDecide は 1 回しか呼ばれない', async () => {
      type EmptySeedResult = { seed: Record<string, never> };
      let resolveDecision: ((value: EmptySeedResult) => void) | null = null;
      const onDecide = jest.fn().mockImplementation(
        () =>
          new Promise<EmptySeedResult>((resolve) => {
            resolveDecision = resolve;
          })
      );
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      pressKey(list, 'i');
      expect(onDecide).toHaveBeenCalledTimes(1);
      resolveDecision!({ seed: {} });
      await flushAsync();
      await flushAsync();
      expect(container.querySelector('.expand__candidate-status')?.textContent).toContain(
        '保存しました'
      );
    });

    test('"e" / "m" キーも対応する判定をトリガする', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'e');
      await flushAsync();
      await flushAsync();
      expect(onDecide.mock.calls[0]![0].decision).toBe('exclude');
      // 既に判定済みなのでフォーカスを次に進めて maybe
      pressKey(list, 'n');
      pressKey(list, 'm');
      await flushAsync();
      await flushAsync();
      expect(onDecide.mock.calls[1]![0].decision).toBe('maybe');
      expect(onDecide.mock.calls[1]![0].pmid).toBe('222');
    });

    test('判定が保存されると自動で次の未判定候補へアクティブが下がる', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const items = container.querySelectorAll<HTMLElement>('.expand__candidate');
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      // 初期は 1 件目がアクティブ
      expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
      // 'i' で 1 件目を判定 → 保存確定後に 2 件目へ自動で下がる（'n' を押さない）
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(items[1]?.classList.contains('expand__candidate--focused')).toBe(true);
      expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(false);
      // そのまま 'm' で 2 件目を判定できる（フォーカス移動の手入力が不要）
      pressKey(list, 'm');
      await flushAsync();
      await flushAsync();
      expect(onDecide.mock.calls[1]![0]).toMatchObject({ pmid: '222', decision: 'maybe' });
    });

    test('保存中（pending）は自動前進せず、同じカードに留まる', async () => {
      type EmptySeedResult = { seed: Record<string, never> };
      let resolveDecision: ((value: EmptySeedResult) => void) | null = null;
      const onDecide = jest.fn().mockImplementation(
        () =>
          new Promise<EmptySeedResult>((resolve) => {
            resolveDecision = resolve;
          })
      );
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const items = container.querySelectorAll<HTMLElement>('.expand__candidate');
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      // 保存解決前はまだ 1 件目がアクティブ（誤って 2 件目へ進まない）
      expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
      resolveDecision!({ seed: {} });
      await flushAsync();
      await flushAsync();
      expect(items[1]?.classList.contains('expand__candidate--focused')).toBe(true);
    });

    test('"ArrowDown" / "ArrowUp" で判定状態を問わず上下移動できる', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const items = container.querySelectorAll<HTMLElement>('.expand__candidate');
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
      pressKey(list, 'ArrowDown');
      expect(items[1]?.classList.contains('expand__candidate--focused')).toBe(true);
      // 端ではそれ以上進まない
      pressKey(list, 'ArrowDown');
      expect(items[1]?.classList.contains('expand__candidate--focused')).toBe(true);
      pressKey(list, 'ArrowUp');
      expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
      pressKey(list, 'ArrowUp');
      expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
    });

    test('マウスで判定ボタンを押すと、そのカードへアクティブが同期される', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const items = container.querySelectorAll<HTMLElement>('.expand__candidate');
      // 初期は 1 件目がアクティブ。2 件目（pmid 222）の include をマウスで押す
      const btn = items[1]!.querySelector<HTMLButtonElement>('button[data-decision=include]')!;
      btn.click();
      // クリック時点でアクティブが 2 件目へ同期される
      expect(items[1]?.classList.contains('expand__candidate--focused')).toBe(true);
      await flushAsync();
      await flushAsync();
      expect(onDecide.mock.calls[0]![0]).toMatchObject({ pmid: '222', decision: 'include' });
    });

    test('"n" / "ArrowRight" は次の未判定候補へ、判定済みはスキップする', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const items = container.querySelectorAll<HTMLElement>('.expand__candidate');
      expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'ArrowRight');
      expect(items[1]?.classList.contains('expand__candidate--focused')).toBe(true);
      pressKey(list, 'n');
      // 循環して 1 件目に戻る（未判定なので）
      expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
    });

    test('"p" / "ArrowLeft" は端で止まる', () => {
      const view = createExpandView();
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const items = container.querySelectorAll<HTMLElement>('.expand__candidate');
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'ArrowLeft');
      // 0 から左は 0 のまま
      expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
      pressKey(list, 'ArrowRight');
      pressKey(list, 'p');
      expect(items[0]?.classList.contains('expand__candidate--focused')).toBe(true);
    });

    test('未対応キー / 候補未取得時のキー入力は無視される', () => {
      const onDecide = jest.fn();
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      // 候補未取得（expandRun なし）: list はあるが keydown ハンドラ未配線なので何も起きない
      view(container, { state: stateReady, navigate: jest.fn() });
      const emptyList = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(emptyList, 'i');
      expect(onDecide).not.toHaveBeenCalled();
      // 取得完了後に未対応キーを押しても何も起きない
      view(container, { state: readyState(), navigate: jest.fn() });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'x');
      expect(onDecide).not.toHaveBeenCalled();
    });

    test('候補 0 件の取得完了でキーを押しても無視される', () => {
      const onDecide = jest.fn();
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      // 候補 0 件（toFetch が空など）。keydown ハンドラは配線されるが items が空
      view(container, {
        state: readyState(sampleResult({ candidates: [], evaluatedCount: 0, additions: [] })),
        navigate: jest.fn(),
      });
      expect(container.querySelector('.expand__candidate')).toBeNull();
      expect(container.querySelector('.expand__status')?.textContent).toContain('探索できませんでした');
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      expect(() => pressKey(list, 'i')).not.toThrow();
      expect(onDecide).not.toHaveBeenCalled();
    });

    test('判定済みの候補に "i" を再度押しても onDecide は呼ばれない', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) })),
        navigate: jest.fn(),
      });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(onDecide).toHaveBeenCalledTimes(1);
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(onDecide).toHaveBeenCalledTimes(1);
    });

    test('全候補判定済みの状態で "n" を押してもエラーにならない', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const onRoundComplete = jest.fn().mockResolvedValue(buildValidationSummary());
      const view = createExpandView({ onDecide, onRoundComplete });
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) })),
        navigate: jest.fn(),
      });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(() => pressKey(list, 'n')).not.toThrow();
    });
  });

  describe('ラウンド完了（再検証）', () => {
    test('全候補を判定し終えると onRoundComplete が呼ばれ、捕捉率を表示する', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const onRoundComplete = jest.fn().mockResolvedValue(buildValidationSummary());
      const view = createExpandView({ onDecide, onRoundComplete });
      const container = buildContainer();
      view(container, { state: readyState(), navigate: jest.fn() });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      pressKey(list, 'n');
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(onRoundComplete).toHaveBeenCalledTimes(1);
      const summary = container.querySelector('.expand__round-summary');
      expect(summary?.textContent).toContain('80.0%');
      expect(summary?.textContent).toContain('4/5');
      expect(summary?.textContent).toContain('5 / 6');
    });

    test('include した式の外側論文から検索式の更新提案を表示する', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const onRoundComplete = jest.fn().mockResolvedValue(buildValidationSummary());
      const view = createExpandView({ onDecide, onRoundComplete });
      const container = buildContainer();
      const result = sampleResult({
        candidates: [
          {
            pmid: '111',
            title: 'Wheezing cohort',
            year: 2021,
            reason: 'boundary',
            abstract: '',
            meshHeadings: ['Lung Diseases'],
          },
        ],
        additions: [
          {
            blockId: '1',
            additions: [
              { term: '"Lung Diseases"[Mesh]', axis: 'mesh', rationale: '親概念へ拡張' },
              { term: '"wheez*"[tiab]', axis: 'freeword', rationale: '同義表現' },
            ],
          },
        ],
      });
      view(container, { state: readyState(result), navigate: jest.fn() });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      const proposals = container.querySelector('.expand__proposals');
      expect(proposals).not.toBeNull();
      expect(proposals?.textContent).toContain('ブロック #1');
      expect(proposals?.textContent).toContain('"Lung Diseases"[Mesh]');
      expect(proposals?.textContent).toContain('"wheez*"[tiab]');
    });

    test('exclude のみなら更新提案は出ない', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const onRoundComplete = jest.fn().mockResolvedValue(buildValidationSummary());
      const view = createExpandView({ onDecide, onRoundComplete });
      const container = buildContainer();
      const result = sampleResult({
        candidates: [
          {
            pmid: '111',
            title: 'Wheezing cohort',
            year: 2021,
            reason: 'boundary',
            abstract: '',
            meshHeadings: ['Lung Diseases'],
          },
        ],
        additions: [
          {
            blockId: '1',
            additions: [{ term: '"Lung Diseases"[Mesh]', axis: 'mesh', rationale: '親概念' }],
          },
        ],
      });
      view(container, { state: readyState(result), navigate: jest.fn() });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'e');
      await flushAsync();
      await flushAsync();
      expect(container.querySelector('.expand__proposals')).toBeNull();
    });

    test('onRoundComplete 未指定の場合は手動 /validate 誘導の案内を表示', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const view = createExpandView({ onDecide });
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) })),
        navigate: jest.fn(),
      });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(container.querySelector('.expand__round-note')?.textContent).toContain('/validate');
    });

    test('onRoundComplete が reject したらエラーを表示', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const onRoundComplete = jest.fn().mockRejectedValue(new Error('quota'));
      const view = createExpandView({ onDecide, onRoundComplete });
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) })),
        navigate: jest.fn(),
      });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(container.querySelector('.expand__round-error')?.textContent).toContain('quota');
    });

    test('onRoundComplete reject の Error 以外も String 化される', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const onRoundComplete = jest.fn().mockRejectedValue('rare');
      const view = createExpandView({ onDecide, onRoundComplete });
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) })),
        navigate: jest.fn(),
      });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(container.querySelector('.expand__round-error')?.textContent).toContain('rare');
    });

    test('summary に finalQueryError がある場合はその旨を表示', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const onRoundComplete = jest
        .fn()
        .mockResolvedValue(buildValidationSummary({ finalQueryError: 'NCBI down' }));
      const view = createExpandView({ onDecide, onRoundComplete });
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) })),
        navigate: jest.fn(),
      });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      const summary = container.querySelector('.expand__round-summary');
      expect(summary?.textContent).toContain('final_query 取得に失敗');
      expect(summary?.textContent).toContain('NCBI down');
    });

    test('有効 seed が 0 件のときは「計算不能」と表示', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const onRoundComplete = jest.fn().mockResolvedValue(
        buildValidationSummary({
          finalQuery: {
            finalQuery: '#1',
            totalHits: 0,
            captureRate: 0,
            capturedPmids: [],
            missedPmids: [],
          },
        })
      );
      const view = createExpandView({ onDecide, onRoundComplete });
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) })),
        navigate: jest.fn(),
      });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(container.querySelector('.expand__round-summary')?.textContent).toContain('計算不能');
    });

    test('inside モードのラウンド完了は初期シードの補足を表示する', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const onRoundComplete = jest.fn().mockResolvedValue(buildValidationSummary());
      const view = createExpandView({ onDecide, onRoundComplete });
      const container = buildContainer();
      view(container, {
        state: readyState(
          sampleResult({
            mode: 'inside',
            additions: [],
            candidates: sampleResult().candidates.slice(0, 1),
          })
        ),
        navigate: jest.fn(),
      });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      const note = container.querySelector('.expand__round-note');
      expect(note?.textContent).toContain('初期シードを 1 件登録しました');
      // inside は additions=[] なので更新提案は出ない
      expect(container.querySelector('.expand__proposals')).toBeNull();
    });

    test('取得中（running）へ再描画すると候補・ラウンド表示がクリアされる', async () => {
      const onDecide = jest.fn().mockResolvedValue({ seed: {} });
      const onRoundComplete = jest.fn().mockResolvedValue(buildValidationSummary());
      const view = createExpandView({ onDecide, onRoundComplete });
      const container = buildContainer();
      view(container, {
        state: readyState(sampleResult({ candidates: sampleResult().candidates.slice(0, 1) })),
        navigate: jest.fn(),
      });
      const list = container.querySelector<HTMLElement>('.expand__candidates')!;
      pressKey(list, 'i');
      await flushAsync();
      await flushAsync();
      expect(container.querySelector('.expand__round-summary')).not.toBeNull();
      // 再取得 → running 状態で再描画 → 候補もラウンド表示も消える
      view(container, { state: runningState('protocol'), navigate: jest.fn() });
      expect(container.querySelector('.expand__candidate')).toBeNull();
      expect(container.querySelector('.expand__round-summary')).toBeNull();
      expect(container.querySelector('.expand__tracker')).not.toBeNull();
    });
  });
});
