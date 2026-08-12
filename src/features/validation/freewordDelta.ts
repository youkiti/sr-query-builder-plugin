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
 * esearch の呼び出し自体は外部から `count` 関数として注入する（テスト容易性と、
 * 呼び出し側でキャッシュを注入できるようにするため）。語数ぶん個別 N 回 + 累積 N-1 回の
 * count を要する。
 *
 * ## 部分失敗の扱い（移植元 check_block_overlap.py の意味論に寄せた設計）
 * - 個別ヒット数の取得は `Promise.allSettled` で行い、1 語の失敗が全体を巻き込まない。
 *   失敗した語は `individual=0` / `individualError=true` とし、以降の累積 OR チェーンからも
 *   除外する（失敗した語の query を OR に混ぜない）。その行は `delta=0` /
 *   `cumulative=直前の累積` / `status='normal'` / `zeroHit=false` で返す。
 * - 累積 OR の count 呼び出しが失敗した場合も分析を打ち切らず、`cumulative=直前の累積` に
 *   フォールバックして `clamped=true` を立て、以降の語の計算を続行する。
 * - 累積は単調増加のはずだが、esearch の揺らぎで逆転する（前語より減る）ことがある。
 *   その場合も前の値にクランプし `clamped=true` を立てる。
 * - クランプされた行の Δ は見かけ上 0 になるが、これは「他の語に内包されて冗長」なのではなく
 *   「取得できなかった／数値が乱れた」ことによる 0 なので、`redundant` とは区別し `normal` 扱いにする
 *   （`redundant` は `individualError` でも `clamped` でもない、純粋な Δ=0 のときだけ付ける）。
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
  /** その語単独のヒット数。individualError のときは 0 */
  individual: number;
  /** この語まで OR で累積したときのヒット数 */
  cumulative: number;
  /** この語が足した純増（= cumulative - 直前の cumulative） */
  delta: number;
  /**
   * - `redundant`: Δ=0。他の語に完全内包されており削除しても件数が変わらない
   * - `lowYield`: Δ>0 だが極小。ほぼ寄与なし
   * - `normal`: 相応に寄与している（individualError / clamped による見かけ上の Δ=0 を含む）
   */
  status: FreewordDeltaStatus;
  /** 個別ヒットが 0（綴り・語形ミスの可能性） */
  zeroHit: boolean;
  /** 個別ヒット数の取得に失敗した。true のときこの行は累積 OR の対象から除外されている */
  individualError: boolean;
  /**
   * 累積ヒット数の取得失敗、または esearch の揺らぎによる逆転で、
   * 直前の累積値をそのまま採用した（真の値ではない）。
   */
  clamped: boolean;
}

export interface FreewordDeltaResult {
  /** 個別ヒット数の降順に並んだ行（先頭の Δ は自分自身の個別数） */
  rows: FreewordDeltaRow[];
  /** 重複除去後の合計（= 最後の cumulative）。OR ブロック全体の実数 */
  totalDeduped: number;
}

export interface FreewordDeltaOptions {
  /** lowYield 判定の相対しきい値（Δ / totalDeduped）。既定 0.01 */
  lowYieldRatio?: number;
}

const DEFAULT_LOW_YIELD_RATIO = 0.01;

/** ソート・累積処理の途中で扱う、個別カウント確定後の語。 */
interface TermWithCount extends FreewordTermInput {
  individual: number;
  individualError: boolean;
}

/**
 * フリーワード群の Δ を計算する。
 *
 * 1. 各語の個別ヒット数を取得（並列、部分失敗を許容）
 * 2. 個別数の降順にソート
 * 3. 上から OR で累積し、各行の Δ（純増）を算出（失敗時はクランプして続行）
 * 4. 全行確定後、totalDeduped に対する相対しきい値で lowYield を後付け判定
 *
 * `count` は同一 query で同じ値を返すこと（キャッシュ推奨）。query が空・重複の語は除外する。
 */
export async function analyzeFreewordDelta(
  terms: readonly FreewordTermInput[],
  count: (query: string) => Promise<number>,
  options: FreewordDeltaOptions = {}
): Promise<FreewordDeltaResult> {
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

  // 1. 個別ヒット数（並列・部分失敗を許容）
  const settled = await Promise.allSettled(unique.map((term) => count(term.query)));
  const withCounts: TermWithCount[] = unique.map((term, i) => {
    const s = settled[i]!;
    return s.status === 'fulfilled'
      ? { ...term, individual: s.value, individualError: false }
      : { ...term, individual: 0, individualError: true };
  });

  // 2. 個別数の降順（同数は表示名で安定ソート）
  withCounts.sort((a, b) => b.individual - a.individual || a.display.localeCompare(b.display));

  // 3. 累積 OR と Δ。individualError の語は OR チェーン（orTerms）に混ぜず、累積を素通りさせる
  const rows: FreewordDeltaRow[] = [];
  const orTerms: TermWithCount[] = [];
  let prevCumulative = 0;
  for (const term of withCounts) {
    if (term.individualError) {
      rows.push({
        display: term.display,
        query: term.query,
        individual: 0,
        cumulative: prevCumulative,
        delta: 0,
        status: 'normal',
        zeroHit: false,
        individualError: true,
        clamped: false,
      });
      continue;
    }

    let cumulative: number;
    let clamped = false;
    if (orTerms.length === 0) {
      // OR チェーンの最初の語。個別数をそのまま流用（count を 1 回節約）
      cumulative = term.individual;
    } else {
      const orQuery = [...orTerms, term].map((t) => `(${t.query})`).join(' OR ');
      try {
        cumulative = await count(orQuery);
      } catch {
        // 累積 count の失敗は分析を止めず、前の値にクランプして続行する
        cumulative = prevCumulative;
        clamped = true;
      }
    }
    if (!clamped && cumulative < prevCumulative) {
      // 累積は単調増加のはず。esearch の揺らぎで逆転したら前の値で抑える
      cumulative = prevCumulative;
      clamped = true;
    }
    const delta = cumulative - prevCumulative;
    rows.push({
      display: term.display,
      query: term.query,
      individual: term.individual,
      cumulative,
      delta,
      status: classifyDelta(delta, term.individual, clamped),
      zeroHit: term.individual === 0,
      individualError: false,
      clamped,
    });
    orTerms.push(term);
    prevCumulative = cumulative;
  }

  applyLowYield(rows, lowYieldRatio, prevCumulative);

  return { rows, totalDeduped: prevCumulative };
}

/**
 * `redundant` / `normal` の一次判定（lowYield は全行確定後に `applyLowYield` が別途付ける）。
 * このコード経路には individualError の行は渡ってこない。
 */
function classifyDelta(delta: number, individual: number, clamped: boolean): FreewordDeltaStatus {
  // 個別ヒット 0 の語は寄与判定の対象外（zeroHit で別途示す）
  if (individual === 0) {
    return 'normal';
  }
  // クランプ由来の見かけ上の Δ=0 は「冗長」ではなく「取得できなかった」なので redundant にしない
  if (delta === 0 && !clamped) {
    return 'redundant';
  }
  return 'normal';
}

/**
 * lowYield は全行の Δ が確定してから、ブロック全体の totalDeduped に対する相対しきい値で判定する
 * （移植元 check_block_overlap.py 準拠。絶対件数のしきい値は使わない）。
 * OR チェーンの先頭語（Δ=ブロック全量そのもの）は対象外。individualError の行も対象外。
 */
function applyLowYield(
  rows: FreewordDeltaRow[],
  lowYieldRatio: number,
  totalDeduped: number
): void {
  const threshold = Math.max(1, Math.round(totalDeduped * lowYieldRatio));
  let headSeen = false;
  for (const row of rows) {
    if (row.individualError) {
      continue;
    }
    if (!headSeen) {
      headSeen = true;
      continue;
    }
    if (row.delta > 0 && row.delta < threshold) {
      row.status = 'lowYield';
    }
  }
}
