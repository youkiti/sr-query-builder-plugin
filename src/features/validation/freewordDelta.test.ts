import { analyzeFreewordDelta, type FreewordTermInput } from './freewordDelta';

/**
 * count 関数のモック。
 * - 個別 query は counts マップから引く
 * - 累積 OR query（`(a) OR (b) ...`）は、含まれる語の和集合サイズを sets から計算する
 */
function makeCounter(
  counts: Record<string, number>,
  sets: Record<string, ReadonlySet<number>> = {}
): { count: (q: string) => Promise<number>; calls: string[] } {
  const calls: string[] = [];
  const count = (q: string): Promise<number> => {
    calls.push(q);
    if (!q.includes(' OR ')) {
      return Promise.resolve(counts[q] ?? 0);
    }
    // 累積 OR: `(x) OR (y)` を分解して和集合
    const parts = q.split(' OR ').map((p) => p.replace(/^\(|\)$/g, ''));
    const union = new Set<number>();
    for (const part of parts) {
      for (const id of sets[part] ?? []) {
        union.add(id);
      }
    }
    return Promise.resolve(union.size);
  };
  return { count, calls };
}

function term(display: string): FreewordTermInput {
  return { display, query: display };
}

describe('analyzeFreewordDelta', () => {
  test('空配列は空結果', async () => {
    const { count } = makeCounter({});
    const res = await analyzeFreewordDelta([], count);
    expect(res.rows).toEqual([]);
    expect(res.totalDeduped).toBe(0);
  });

  test('個別ヒット数の降順に並ぶ', async () => {
    const { count } = makeCounter(
      { 'a[tiab]': 100, 'b[tiab]': 300, 'c[tiab]': 200 },
      {
        'a[tiab]': new Set([1]),
        'b[tiab]': new Set([2, 3, 4]),
        'c[tiab]': new Set([5, 6]),
      }
    );
    const res = await analyzeFreewordDelta(
      [term('a[tiab]'), term('b[tiab]'), term('c[tiab]')],
      count
    );
    expect(res.rows.map((r) => r.display)).toEqual(['b[tiab]', 'c[tiab]', 'a[tiab]']);
  });

  test('1 語目の Δ は個別数そのもの、累積 OR で純増を出す', async () => {
    // a:{1,2,3}, b:{3,4} → 個別 a=3, b=2。降順は a,b。累積 a=3, a|b={1,2,3,4}=4 → Δb=1
    const { count, calls } = makeCounter(
      { 'a[tiab]': 3, 'b[tiab]': 2 },
      { 'a[tiab]': new Set([1, 2, 3]), 'b[tiab]': new Set([3, 4]) }
    );
    const res = await analyzeFreewordDelta([term('a[tiab]'), term('b[tiab]')], count);
    expect(res.rows[0]).toMatchObject({ display: 'a[tiab]', individual: 3, cumulative: 3, delta: 3 });
    expect(res.rows[1]).toMatchObject({ display: 'b[tiab]', individual: 2, cumulative: 4, delta: 1 });
    expect(res.totalDeduped).toBe(4);
    // 1 語目は個別数を流用し累積 count を呼ばない（個別 2 回 + 累積 1 回 = 3 回）
    expect(calls).toHaveLength(3);
  });

  test('完全内包の語は Δ=0 で redundant', async () => {
    // big:{1,2,3,4}, sub:{1,2} は big に内包 → 個別 big=4 sub=2、降順 big,sub。累積 big|sub=4 → Δsub=0
    const { count } = makeCounter(
      { 'big[tiab]': 4, 'sub[tiab]': 2 },
      { 'big[tiab]': new Set([1, 2, 3, 4]), 'sub[tiab]': new Set([1, 2]) }
    );
    const res = await analyzeFreewordDelta([term('big[tiab]'), term('sub[tiab]')], count);
    const sub = res.rows.find((r) => r.display === 'sub[tiab]')!;
    expect(sub.delta).toBe(0);
    expect(sub.status).toBe('redundant');
  });

  test('純増がしきい値未満なら lowYield', async () => {
    // base:{1..1000}, tiny が +4 だけ足す
    const baseSet = new Set<number>();
    for (let i = 1; i <= 1000; i += 1) baseSet.add(i);
    const tinySet = new Set<number>([1, 2, 1001, 1002, 1003, 1004]); // 個別 6, 純増 4
    const { count } = makeCounter(
      { 'base[tiab]': 1000, 'tiny[tiab]': 6 },
      { 'base[tiab]': baseSet, 'tiny[tiab]': tinySet }
    );
    const res = await analyzeFreewordDelta([term('base[tiab]'), term('tiny[tiab]')], count);
    const tiny = res.rows.find((r) => r.display === 'tiny[tiab]')!;
    expect(tiny.delta).toBe(4);
    expect(tiny.status).toBe('lowYield');
  });

  test('個別ヒット 0 は zeroHit、status は normal 扱い', async () => {
    const { count } = makeCounter(
      { 'a[tiab]': 10, 'dead[tiab]': 0 },
      { 'a[tiab]': new Set([1]), 'dead[tiab]': new Set() }
    );
    const res = await analyzeFreewordDelta([term('a[tiab]'), term('dead[tiab]')], count);
    const dead = res.rows.find((r) => r.display === 'dead[tiab]')!;
    expect(dead.zeroHit).toBe(true);
    expect(dead.status).toBe('normal');
    expect(dead.delta).toBe(0);
  });

  test('query で重複除去する', async () => {
    const { count } = makeCounter(
      { 'a[tiab]': 5 },
      { 'a[tiab]': new Set([1, 2, 3, 4, 5]) }
    );
    const res = await analyzeFreewordDelta([term('a[tiab]'), term('a[tiab]')], count);
    expect(res.rows).toHaveLength(1);
  });

  test('esearch の揺らぎで累積が逆転しても単調増加に抑える（clamped=true・status=normal）', async () => {
    // 累積 OR が個別より小さい異常値を返すケース
    const counts: Record<string, number> = { 'a[tiab]': 100, 'b[tiab]': 50 };
    const calls: string[] = [];
    const count = (q: string): Promise<number> => {
      calls.push(q);
      if (q.includes(' OR ')) {
        return Promise.resolve(80); // 逆転した異常値（< 100）
      }
      return Promise.resolve(counts[q] ?? 0);
    };
    const res = await analyzeFreewordDelta([term('a[tiab]'), term('b[tiab]')], count);
    expect(res.rows[0]!.cumulative).toBe(100);
    expect(res.rows[0]!.clamped).toBe(false);
    expect(res.rows[1]!.cumulative).toBe(100); // 80 ではなく 100 に抑える
    expect(res.rows[1]!.delta).toBe(0);
    // クランプ由来の Δ=0 は「冗長で削除しても件数不変」ではないので redundant にはしない
    expect(res.rows[1]!.clamped).toBe(true);
    expect(res.rows[1]!.status).toBe('normal');
  });

  test('総ヒットが小さいブロックの先頭行は lowYield にならない（絶対しきい値 10 の廃止を確認）', async () => {
    // 総ヒット 5 件（旧・絶対しきい値 10 未満）の小ブロック。先頭行は「ブロック全量そのもの」の
    // Δ を持つが、旧ロジック（絶対しきい値 10）だと delta(5) < 10 で lowYield に誤判定されていた。
    const { count } = makeCounter({ 'a[tiab]': 5 }, { 'a[tiab]': new Set([1, 2, 3, 4, 5]) });
    const res = await analyzeFreewordDelta([term('a[tiab]')], count);
    expect(res.totalDeduped).toBe(5);
    expect(res.rows[0]!.delta).toBe(5);
    expect(res.rows[0]!.status).toBe('normal');
  });

  test('個別 count が 1 語だけ reject しても他の語の行が返り、失敗語は累積から除外される', async () => {
    const sets: Record<string, ReadonlySet<number>> = {
      'a[tiab]': new Set([1, 2, 3]),
      'c[tiab]': new Set([4, 5]),
    };
    const individuals: Record<string, number> = { 'a[tiab]': 3, 'c[tiab]': 2 };
    const count = (q: string): Promise<number> => {
      if (q === 'b[tiab]') {
        return Promise.reject(new Error('esearch failed'));
      }
      if (!q.includes(' OR ')) {
        return Promise.resolve(individuals[q] ?? 0);
      }
      const parts = q.split(' OR ').map((p) => p.replace(/^\(|\)$/g, ''));
      const union = new Set<number>();
      for (const part of parts) {
        for (const id of sets[part] ?? []) union.add(id);
      }
      return Promise.resolve(union.size);
    };
    const res = await analyzeFreewordDelta(
      [term('a[tiab]'), term('b[tiab]'), term('c[tiab]')],
      count
    );
    expect(res.rows).toHaveLength(3);
    const b = res.rows.find((r) => r.display === 'b[tiab]')!;
    expect(b.individualError).toBe(true);
    expect(b.individual).toBe(0);
    expect(b.delta).toBe(0);
    expect(b.status).toBe('normal');
    // 失敗語は累積 OR チェーンから除外される（a ∪ c の和集合 = 5 件のみ）
    expect(res.totalDeduped).toBe(5);
  });

  test('累積 count の途中失敗で clamped=true になり分析が継続する', async () => {
    // a:{1..10}, b:{11..15}, c:{16..18} はすべて素（互いに重複なし）
    const individuals: Record<string, number> = { 'a[tiab]': 10, 'b[tiab]': 5, 'c[tiab]': 3 };
    const count = (q: string): Promise<number> => {
      if (!q.includes(' OR ')) {
        return Promise.resolve(individuals[q] ?? 0);
      }
      if (q === '(a[tiab]) OR (b[tiab])') {
        // a と b の累積 OR だけ失敗させる
        return Promise.reject(new Error('esearch failed'));
      }
      if (q === '(a[tiab]) OR (b[tiab]) OR (c[tiab])') {
        return Promise.resolve(18); // 10 + 5 + 3（素なので単純和）
      }
      return Promise.reject(new Error(`unexpected query: ${q}`));
    };
    const res = await analyzeFreewordDelta(
      [term('a[tiab]'), term('b[tiab]'), term('c[tiab]')],
      count
    );
    const a = res.rows.find((r) => r.display === 'a[tiab]')!;
    const b = res.rows.find((r) => r.display === 'b[tiab]')!;
    const c = res.rows.find((r) => r.display === 'c[tiab]')!;
    expect(a).toMatchObject({ cumulative: 10, delta: 10, clamped: false });
    // b の累積 count が失敗 → 前値（10）にクランプして続行。redundant ではなく normal
    expect(b).toMatchObject({ cumulative: 10, delta: 0, clamped: true, status: 'normal' });
    // クランプ後も分析は継続し、c は a+b+c の実測値で正しく計算される
    expect(c).toMatchObject({ cumulative: 18, delta: 8, clamped: false });
    expect(res.totalDeduped).toBe(18);
  });

  test('相対しきい値: totalDeduped の 1% 未満の Δ が lowYield、以上が normal', async () => {
    const baseSet = new Set<number>();
    for (let i = 1; i <= 1000; i += 1) baseSet.add(i);
    const bigSet = new Set<number>();
    for (let i = 1001; i <= 1015; i += 1) bigSet.add(i); // 個別・純増ともに 15
    const smallSet = new Set<number>();
    for (let i = 1016; i <= 1020; i += 1) smallSet.add(i); // 個別・純増ともに 5
    const { count } = makeCounter(
      { 'base[tiab]': 1000, 'big[tiab]': 15, 'small[tiab]': 5 },
      { 'base[tiab]': baseSet, 'big[tiab]': bigSet, 'small[tiab]': smallSet }
    );
    const res = await analyzeFreewordDelta(
      [term('base[tiab]'), term('big[tiab]'), term('small[tiab]')],
      count
    );
    // totalDeduped=1020 → しきい値 = round(1020 * 0.01) = 10
    expect(res.totalDeduped).toBe(1020);
    const big = res.rows.find((r) => r.display === 'big[tiab]')!;
    const small = res.rows.find((r) => r.display === 'small[tiab]')!;
    expect(big.delta).toBe(15); // 15 >= 10 → normal
    expect(big.status).toBe('normal');
    expect(small.delta).toBe(5); // 5 < 10 → lowYield
    expect(small.status).toBe('lowYield');
  });
});
