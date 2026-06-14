import { fetchMeshTreeNumbers, parseMeshSummaryJson } from './mesh';

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

/**
 * 実 NCBI `esummary db=mesh&retmode=json` の形状を模したヘルパ。
 * tree number は ds_idxlinks[].treenum に入る（複数 tree number = 複数要素）。
 */
function meshSummary(records: Array<{ uid: string; treenums: string[] }>): unknown {
  const result: Record<string, unknown> = { uids: records.map((r) => r.uid) };
  for (const r of records) {
    result[r.uid] = {
      uid: r.uid,
      ds_idxlinks: r.treenums.map((t) => ({ treenum: t })),
    };
  }
  return { header: { type: 'esummary', version: '0.3' }, result };
}

// Asthma は実際に 4 本の tree number を持つ（実 API で確認済み）。
const SUMMARY_ASTHMA = meshSummary([
  { uid: '1001', treenums: ['C08.127.108', 'C08.381.495.108'] },
]);

const SUMMARY_MULTI = meshSummary([
  { uid: '1001', treenums: ['C08.127.108'] },
  { uid: '1002', treenums: ['C08.127.108.562'] },
]);

describe('parseMeshSummaryJson', () => {
  test('uid ごとに ds_idxlinks.treenum を抽出する', () => {
    const out = parseMeshSummaryJson(
      meshSummary([{ uid: '68001249', treenums: ['C08.127.108', 'C20.543.480.680.095'] }]) as never
    );
    expect(out.get('68001249')).toEqual(['C08.127.108', 'C20.543.480.680.095']);
  });

  test('treenum が空テキストのものは除外される', () => {
    const out = parseMeshSummaryJson({
      result: {
        uids: ['1'],
        '1': { ds_idxlinks: [{ treenum: '   ' }, { treenum: 'Z01' }] },
      },
    });
    expect(out.get('1')).toEqual(['Z01']);
  });

  test('ds_idxlinks が空 / 欠落の uid は Map に入らない', () => {
    const out = parseMeshSummaryJson({
      result: {
        uids: ['1', '2'],
        '1': { ds_idxlinks: [] },
        '2': {},
      },
    });
    expect(out.size).toBe(0);
  });

  test('result が無ければ空 Map', () => {
    expect(parseMeshSummaryJson({}).size).toBe(0);
  });
});

describe('fetchMeshTreeNumbers', () => {
  test('空配列 → 空 Map、fetch は呼ばれない', async () => {
    const fetch = jest.fn();
    const result = await fetchMeshTreeNumbers([], { fetch });
    expect(result.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('descriptor ごとに esearch → esummary(1 回まとめて) を呼び、Map を返す', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi') && url.includes('term=Asthma%5Bmh%5D')) {
        return jsonResponse({ esearchresult: { idlist: ['1001'] } });
      }
      if (url.includes('esearch.fcgi') && url.includes('term=Bronchitis%5Bmh%5D')) {
        return jsonResponse({ esearchresult: { idlist: ['1002'] } });
      }
      if (url.includes('esummary.fcgi') && url.includes('db=mesh')) {
        expect(url).toContain('id=1001%2C1002');
        expect(url).toContain('retmode=json');
        return jsonResponse(SUMMARY_MULTI);
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const result = await fetchMeshTreeNumbers(['Asthma', 'Bronchitis'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.get('Asthma')).toEqual(['C08.127.108']);
    expect(result.get('Bronchitis')).toEqual(['C08.127.108.562']);
  });

  test('descriptor の前後空白を trim し、重複は除外する', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1001'] } });
      }
      return jsonResponse(SUMMARY_ASTHMA);
    });
    const result = await fetchMeshTreeNumbers(['  Asthma  ', 'Asthma'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.get('Asthma')).toEqual(['C08.127.108', 'C08.381.495.108']);
    // esearch は 1 回だけ
    expect((fetch as jest.Mock).mock.calls.filter((c) => (c[0] as string).includes('esearch')).length).toBe(1);
  });

  test('esearch が空を返した descriptor は Map に入らない', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: [] } });
      }
      return jsonResponse(SUMMARY_ASTHMA);
    });
    const result = await fetchMeshTreeNumbers(['Unknown'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.size).toBe(0);
  });

  test('esearch が 2 件以上返した（曖昧）descriptor も Map に入らない', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1', '2'] } });
      }
      return jsonResponse(SUMMARY_ASTHMA);
    });
    const result = await fetchMeshTreeNumbers(['Ambiguous'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.size).toBe(0);
  });

  test('全 descriptor が解決不能なら esummary を呼ばず空 Map', async () => {
    const fetch = jest.fn(async () => jsonResponse({ esearchresult: { idlist: [] } }));
    const result = await fetchMeshTreeNumbers(['X', 'Y'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.size).toBe(0);
    expect((fetch as jest.Mock).mock.calls.some((c) => (c[0] as string).includes('esummary'))).toBe(false);
  });

  test('esearch が 4xx を返したら EutilsError（リトライ上限到達）', async () => {
    const fetch = jest.fn(async () => errorResponse(400));
    await expect(
      fetchMeshTreeNumbers(['X'], {
        fetch: fetch as unknown as typeof globalThis.fetch,
        maxRetries: 1,
        sleep: async () => undefined,
      })
    ).rejects.toThrow('mesh esearch failed');
  });

  test('esummary が 5xx を返したら EutilsError', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1'] } });
      }
      return errorResponse(500);
    });
    await expect(
      fetchMeshTreeNumbers(['X'], {
        fetch: fetch as unknown as typeof globalThis.fetch,
        maxRetries: 1,
        sleep: async () => undefined,
      })
    ).rejects.toThrow('mesh esummary failed');
  });

  test('apiKey / email / tool は共通パラメータで両 API に載る', async () => {
    const calls: string[] = [];
    const fetch = jest.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1'] } });
      }
      return jsonResponse(SUMMARY_ASTHMA);
    });
    await fetchMeshTreeNumbers(['Asthma'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
      apiKey: 'KEY',
      email: 'me@x',
      tool: 'mytool',
    });
    for (const u of calls) {
      expect(u).toContain('api_key=KEY');
      expect(u).toContain('email=me%40x');
      expect(u).toContain('tool=mytool');
    }
  });

  test('空文字列 descriptor は除外される', async () => {
    const fetch = jest.fn(async () => jsonResponse({ esearchresult: { idlist: ['1'] } }));
    const result = await fetchMeshTreeNumbers(['', '   '], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('esearch レスポンスが esearchresult / idlist を欠いても null 扱いで Map に入らない', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({});
      }
      return jsonResponse(SUMMARY_ASTHMA);
    });
    const result = await fetchMeshTreeNumbers(['X'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.size).toBe(0);
  });

  test('esearch で UID が解決したが esummary に tree number が無い descriptor は Map に入らない', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1'] } });
      }
      // ds_idxlinks が空 = tree number 無し（例: 最上位カテゴリや索引リンク未整備）
      return jsonResponse({ result: { uids: ['1'], '1': { ds_idxlinks: [] } } });
    });
    const result = await fetchMeshTreeNumbers(['X'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.size).toBe(0);
  });
});
