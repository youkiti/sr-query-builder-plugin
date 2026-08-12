import { EutilsError } from './eutils';
import { fetchMeshChildren, fetchMeshLabels, type SparqlJson } from './meshRdf';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => '',
  } as Response;
}

/** 実 SPARQL JSON（application/sparql-results+json）の形を模す。 */
function sparql(
  rows: Array<{ tn: string; desc: string; label: string; hasKids?: string }>,
  tnVar: 'childTN' | 'tn' = 'childTN'
): SparqlJson {
  return {
    results: {
      bindings: rows.map((r) => {
        const binding: Record<string, { type: string; value: string }> = {
          [tnVar]: { type: 'uri', value: `http://id.nlm.nih.gov/mesh/${r.tn}` },
          desc: { type: 'uri', value: `http://id.nlm.nih.gov/mesh/${r.desc}` },
          label: { type: 'literal', value: r.label },
        };
        if (r.hasKids !== undefined) {
          binding.hasKids = { type: 'literal', value: r.hasKids };
        }
        return binding;
      }),
    },
  };
}

describe('fetchMeshChildren', () => {
  test('子ノードを tree number / descriptor UI / label に分解し label 昇順で返す', async () => {
    const fetch = jest.fn(async (url: string) => {
      expect(url).toContain('id.nlm.nih.gov/mesh/sparql');
      expect(url).toContain('format=JSON');
      // クエリに親 tree number が IRI として含まれる
      expect(decodeURIComponent(url)).toContain('mesh:M01.526.485.810.910');
      // クエリに hasChildren 判定の EXISTS が含まれる
      expect(decodeURIComponent(url)).toContain('EXISTS');
      // TopicalDescriptor 型制約が入っている（Y 系 qualifier 等の除外）
      expect(decodeURIComponent(url)).toContain('meshv:TopicalDescriptor');
      return jsonResponse(
        sparql([
          { tn: 'M01.526.485.810.910.750', desc: 'D000069471', label: 'Neurosurgeons', hasKids: '0' },
          { tn: 'M01.526.485.810.910.813', desc: 'D000066794', label: 'Oral and Maxillofacial Surgeons', hasKids: '1' },
          { tn: 'M01.526.485.810.910.500', desc: 'D019024', label: 'Barber Surgeons', hasKids: '0' },
        ])
      );
    });
    const result = await fetchMeshChildren('M01.526.485.810.910', {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.map((n) => n.label)).toEqual([
      'Barber Surgeons',
      'Neurosurgeons',
      'Oral and Maxillofacial Surgeons',
    ]);
    const neuro = result.find((n) => n.label === 'Neurosurgeons');
    expect(neuro).toEqual({
      treeNumber: 'M01.526.485.810.910.750',
      descriptorUi: 'D000069471',
      label: 'Neurosurgeons',
      hasChildren: false,
    });
    // hasKids="1" は hasChildren:true
    expect(result.find((n) => n.label === 'Oral and Maxillofacial Surgeons')?.hasChildren).toBe(true);
  });

  test('不正な tree number は fetch せず空配列', async () => {
    const fetch = jest.fn();
    const result = await fetchMeshChildren('not a tree number', {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('子が無い（bindings 空）なら空配列', async () => {
    const fetch = jest.fn(async () => jsonResponse({ results: { bindings: [] } }));
    const result = await fetchMeshChildren('C08.127.108', {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result).toEqual([]);
  });

  test('label / desc / tn を欠く binding は除外する', async () => {
    const fetch = jest.fn(async () =>
      jsonResponse({
        results: {
          bindings: [
            { childTN: { value: 'http://id.nlm.nih.gov/mesh/C08.1' }, label: { value: 'x' } },
            {
              childTN: { value: 'http://id.nlm.nih.gov/mesh/C08.2' },
              desc: { value: 'http://id.nlm.nih.gov/mesh/D1' },
              label: { value: 'Valid' },
            },
          ],
        },
      })
    );
    const result = await fetchMeshChildren('C08', {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result).toEqual([
      { treeNumber: 'C08.2', descriptorUi: 'D1', label: 'Valid', hasChildren: false },
    ]);
  });

  test('HTTP エラーは EutilsError', async () => {
    const fetch = jest.fn(async () => errorResponse(500));
    await expect(
      fetchMeshChildren('C08', {
        fetch: fetch as unknown as typeof globalThis.fetch,
        maxRetries: 1,
        sleep: async () => undefined,
      })
    ).rejects.toThrow('mesh sparql failed');
  });

  test('HTTP 400 は恒久エラー扱いで fetch 1 回のみ・リトライしない', async () => {
    const fetch = jest.fn(async () => errorResponse(400));
    const sleep = jest.fn().mockResolvedValue(undefined);
    const promise = fetchMeshChildren('C08', {
      fetch: fetch as unknown as typeof globalThis.fetch,
      maxRetries: 5,
      sleep,
    });
    await expect(promise).rejects.toBeInstanceOf(EutilsError);
    await expect(promise).rejects.toMatchObject({ permanent: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('HTTP 429 はリトライされる', async () => {
    let calls = 0;
    const fetch = jest.fn(async () => {
      calls += 1;
      if (calls < 3) {
        return errorResponse(429);
      }
      return jsonResponse(sparql([{ tn: 'C08.1', desc: 'D1', label: 'X' }]));
    });
    const result = await fetchMeshChildren('C08', {
      fetch: fetch as unknown as typeof globalThis.fetch,
      maxRetries: 5,
      sleep: async () => undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(1);
  });

  test('HTTP 500 はリトライされる', async () => {
    let calls = 0;
    const fetch = jest.fn(async () => {
      calls += 1;
      if (calls < 2) {
        return errorResponse(500);
      }
      return jsonResponse(sparql([{ tn: 'C08.1', desc: 'D1', label: 'X' }]));
    });
    const result = await fetchMeshChildren('C08', {
      fetch: fetch as unknown as typeof globalThis.fetch,
      maxRetries: 5,
      sleep: async () => undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  test('前後に空白が付いた tree number でも trim して fetch する', async () => {
    const fetch = jest.fn(async (url: string) => {
      expect(decodeURIComponent(url)).toContain('mesh:C08.127.108');
      return jsonResponse(sparql([{ tn: 'C08.127.108.1', desc: 'D1', label: 'X' }]));
    });
    const result = await fetchMeshChildren('  C08.127.108  ', {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });
});

describe('fetchMeshLabels', () => {
  test('複数 tree number を VALUES でバッチ解決し Map を返す', async () => {
    const fetch = jest.fn(async (url: string) => {
      // URLSearchParams は空白を `+` にするので空白へ戻してから検査する
      const decoded = decodeURIComponent(url).replace(/\+/g, ' ');
      expect(decoded).toContain('VALUES ?tn');
      expect(decoded).toContain('mesh:M01.526.485.810');
      expect(decoded).toContain('mesh:M01.526.485');
      // TopicalDescriptor 型制約が入っている
      expect(decoded).toContain('meshv:TopicalDescriptor');
      return jsonResponse(
        sparql(
          [
            { tn: 'M01.526.485.810', desc: 'D010820', label: 'Physicians' },
            { tn: 'M01.526.485', desc: 'D006282', label: 'Health Personnel' },
          ],
          'tn'
        )
      );
    });
    const result = await fetchMeshLabels(['M01.526.485.810', 'M01.526.485'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.get('M01.526.485.810')?.label).toBe('Physicians');
    expect(result.get('M01.526.485')?.label).toBe('Health Personnel');
  });

  test('不正な tree number は除外し、全滅なら fetch しない', async () => {
    const fetch = jest.fn();
    const result = await fetchMeshLabels(['', '   ', 'bogus'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('重複 tree number は 1 回だけ VALUES に載せる', async () => {
    const fetch = jest.fn(async (url: string) => {
      const decoded = decodeURIComponent(url).replace(/\+/g, ' ');
      // mesh:C08.127 が 1 回だけ出現する
      expect(decoded.match(/mesh:C08\.127(?![.\d])/g)?.length).toBe(1);
      return jsonResponse(sparql([{ tn: 'C08.127', desc: 'D1', label: 'L' }], 'tn'));
    });
    await fetchMeshLabels(['C08.127', ' C08.127 '], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('150 件渡すと fetch が 2 回（100 件 + 50 件）呼ばれ両チャンクの結果がマージされる', async () => {
    const treeNumbers = Array.from({ length: 150 }, (_, i) => `C08.${String(i + 1).padStart(3, '0')}`);
    const fetch = jest.fn(async (url: string) => {
      const decoded = decodeURIComponent(url).replace(/\+/g, ' ');
      // どのチャンクかを、含まれる tree number から判定して対応する行だけ返す
      // （VALUES 句は `{ mesh:X mesh:Y ... }` の形で必ず末尾にも空白が付くため、`mesh:X ` で判定できる）
      const chunkTreeNumbers = treeNumbers.filter((tn) => decoded.includes(`mesh:${tn} `));
      return jsonResponse(
        sparql(
          chunkTreeNumbers.map((tn, i) => ({ tn, desc: `D${i}`, label: `Label ${tn}` })),
          'tn'
        )
      );
    });
    const result = await fetchMeshLabels(treeNumbers, {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(150);
    expect(result.get('C08.001')?.label).toBe('Label C08.001');
    expect(result.get('C08.150')?.label).toBe('Label C08.150');
  });
});
