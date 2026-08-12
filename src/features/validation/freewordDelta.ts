/**
 * フリーワード（`[tiab]` 等）の「個別ヒット数」と「累積 OR したときの純増（Δ）」を計算する。
 *
 * ブロック編集画面のインスペクタで、各フリーワードが検索式にどれだけ寄与しているかを
 * 行ごとに可視化するためのロジック。個別ヒット数の多い順に並べ、上から OR で足していき、
 * 各語が「上の語たちで拾えなかった新規」を何件もたらすか（Δ）を出す。
 *
 * - Δ = 0（個別ヒットはあるのに純増ゼロ）→ 他の語に完全に内包されており削除候補
 * - Δ が極小（純増がわずか）→ ほぼ寄与なしの低収量語
 *
 * esearch の呼び出し自体は外部から `count` 関数として注入する（テスト容易性 + edit
 * 画面の hitsCache を再利用するため）。語数ぶん個別 N 回 + 累積 N-1 回の count を要する。
 */

/** Δ 計算に渡すフリーワード 1 語。 */
export interface FreewordTermInput {
  /** 表示用テキスト（タグ込み）。例: `asthma*[tiab]` */
  display: string;
  /** esearch にかける式。通常は display と同じ */
  query: string;
}

/** Δ の判定区分。 */
export type FreewordDeltaStatus = 'normal' | 'lowYield' | 'redundant';

/** Δ 計算結果の 1 行。 */
export interface FreewordDeltaRow {
  display: string;
  query: string;
  /** その語単独のヒット数 */
  individual: number;
  /** この語まで OR で累積したときのヒット数 */
  cumulative: number;
  /** この語が足した純増（= cumulative - 直前の cumulative） */
  delta: number;
  /**
   * - `redundant`: Δ=0。他の語に完全内包されており削除しても件数が変わらない
   * - `lowYield`: Δ>0 だが極小。ほぼ寄与なし
   * - `normal`: 相応に寄与している
   */
  status: FreewordDeltaStatus;
  /** 個別ヒットが 0（綴り・語形ミスの可能性） */
  zeroHit: boolean;
}

export interface FreewordDeltaResult {
  /** 個別ヒット数の降順に並んだ行（先頭の Δ は自分自身の個別数） */
  rows: FreewordDeltaRow[];
  /** 重複除去後の合計（= 最後の cumulative）。OR ブロック全体の実数 */
  totalDeduped: number;
}

export interface FreewordDeltaOptions {
  /** lowYield 判定の絶対しきい値（Δ がこれ未満なら低収量候補）。既定 10 */
  lowYieldAbs?: number;
  /** lowYield 判定の相対しきい値（Δ / その時点の累積）。既定 0.005 */
  lowYieldRatio?: number;
}

const DEFAULT_LOW_YIELD_ABS = 10;
const DEFAULT_LOW_YIELD_RATIO = 0.005;

/**
 * フリーワード群の Δ を計算する。
 *
 * 1. 各語の個別ヒット数を取得（並列）
 * 2. 個別数の降順にソート
 * 3. 上から OR で累積し、各行の Δ（純増）を算出
 *
 * `count` は同一 query で同じ値を返すこと（キャッシュ推奨）。query が空・重複の語は除外する。
 */
export async function analyzeFreewordDelta(
  terms: readonly FreewordTermInput[],
  count: (query: string) => Promise<number>,
  options: FreewordDeltaOptions = {}
): Promise<FreewordDeltaResult> {
  const lowYieldAbs = options.lowYieldAbs ?? DEFAULT_LOW_YIELD_ABS;
  const lowYieldRatio = options.lowYieldRatio ?? DEFAULT_LOW_YIELD_RATIO;

  // query で重複除去（表示は最初に現れたものを採用）
  const seen = new Set<string>();
  const unique: FreewordTermInput[] = [];
  for (const term of terms) {
    const key = term.query.trim();
    if (key === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(term);
  }
  if (unique.length === 0) {
    return { rows: [], totalDeduped: 0 };
  }

  // 1. 個別ヒット数（並列）
  const individuals = await Promise.all(unique.map((term) => count(term.query)));
  const withCounts = unique.map((term, i) => ({ ...term, individual: individuals[i] ?? 0 }));

  // 2. 個別数の降順（同数は表示名で安定ソート）
  withCounts.sort((a, b) => b.individual - a.individual || a.display.localeCompare(b.display));

  // 3. 累積 OR と Δ
  const rows: FreewordDeltaRow[] = [];
  let prevCumulative = 0;
  for (let i = 0; i < withCounts.length; i += 1) {
    const term = withCounts[i]!;
    let cumulative: number;
    if (i === 0) {
      // 1 語目の累積は個別数そのもの（count を 1 回節約）
      cumulative = term.individual;
    } else {
      const orQuery = withCounts
        .slice(0, i + 1)
        .map((t) => `(${t.query})`)
        .join(' OR ');
      cumulative = await count(orQuery);
    }
    // 累積は単調増加のはず。esearch の揺らぎで逆転したら前の値で抑える
    if (cumulative < prevCumulative) {
      cumulative = prevCumulative;
    }
    const delta = cumulative - prevCumulative;
    rows.push({
      display: term.display,
      query: term.query,
      individual: term.individual,
      cumulative,
      delta,
      status: classifyDelta(delta, term.individual, cumulative, lowYieldAbs, lowYieldRatio),
      zeroHit: term.individual === 0,
    });
    prevCumulative = cumulative;
  }

  return { rows, totalDeduped: prevCumulative };
}

function classifyDelta(
  delta: number,
  individual: number,
  cumulative: number,
  lowYieldAbs: number,
  lowYieldRatio: number
): FreewordDeltaStatus {
  // 個別ヒット 0 の語は寄与判定の対象外（zeroHit で別途示す）
  if (individual === 0) {
    return 'normal';
  }
  if (delta === 0) {
    return 'redundant';
  }
  const threshold = Math.max(lowYieldAbs, Math.round(cumulative * lowYieldRatio));
  if (delta < threshold) {
    return 'lowYield';
  }
  return 'normal';
}
