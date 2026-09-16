import { resolveMeshDescriptors, fetchMeshTreeNumbers, parseMeshSummaryJson } from './mesh';
import { sharedEutilsRateLimiters } from './eutils';
import type { RateLimiter } from './rateLimit';

// テストごとに満タンへ戻す。issue #59 のトークンバケットはプロセス共有（モジュールスコープの
// シングルトン）で、mesh.ts は eutils.ts と同じバケットを再利用する（issue #58 chunk 3a
// フォローアップ）。リセットしないと直前のテストで消費したトークンが持ち越され、実タイマーでの
// 待機が発生してテストが不安定になる（eutils.test.ts の同種の注記を参照）。
beforeEach(() => {
  sharedEutilsRateLimiters.withoutApiKey.reset();
  sharedEutilsRateLimiters.withApiKey.reset();
});

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
function meshSummary(records: Array<{ uid: string; treenums: string[]; terms?: string[] }>): unknown {
  const result: Record<string, unknown> = { uids: records.map((r) => r.uid) };
  for (const r of records) {
    result[r.uid] = {
      uid: r.uid,
      ds_recordtype: 'descriptor',
      ds_meshterms: r.terms ?? [],
      ds_idxlinks: r.treenums.map((t) => ({ treenum: t })),
    };
  }
  return { header: { type: 'esummary', version: '0.3' }, result };
}

// Asthma は実際に 4 本の tree number を持つ（実 API で確認済み）。
const SUMMARY_ASTHMA = meshSummary([
  { uid: '1001', terms: ['Asthma'], treenums: ['C08.127.108', 'C08.381.495.108'] },
]);

const SUMMARY_MULTI = meshSummary([
  { uid: '1001', terms: ['Asthma'], treenums: ['C08.127.108'] },
  { uid: '1002', terms: ['Bronchitis'], treenums: ['C08.127.108.562'] },
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
    expect(result.trees.size).toBe(0);
    expect(result.reasons.size).toBe(0);
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
    expect(result.trees.get('Asthma')).toEqual(['C08.127.108']);
    expect(result.trees.get('Bronchitis')).toEqual(['C08.127.108.562']);
  });

  test('descriptor の前後空白を trim し、重複は除外する', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1001'] } });
      }
      return jsonResponse(SUMMARY_ASTHMA);
    });
    const result = await fetchMeshTreeNumbers(['  Asthma  ', 'Asthma'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.trees.get('Asthma')).toEqual(['C08.127.108', 'C08.381.495.108']);
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
    expect(result.trees.size).toBe(0);
    expect(result.reasons.get('Unknown')).toContain('該当なし');
  });

  test('薬理作用レコードと descriptor の 2 件が返ったら descriptor 側の tree number を返す', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { idlist: ['82006490', '68006490'] } }))
      .mockResolvedValueOnce(jsonResponse({ result: { uids: ['82006490', '68006490'],
        '82006490': { ds_recordtype: 'pharmacological-action', ds_meshui: 'D006490',
          ds_meshterms: ['Hemostatics'], ds_idxlinks: [{ treenum: 'D006490' }] },
        '68006490': { ds_recordtype: 'descriptor', ds_meshui: 'D006490',
          ds_meshterms: ['Hemostatics', 'Hemostatic', 'Antihemorrhagics', 'Antihemorrhagic'],
          ds_idxlinks: [{ treenum: 'D27.505.954.502.270.463' }] },
      } }));
    const result = await fetchMeshTreeNumbers(['Hemostatics'], { fetch });
    expect(result.trees.get('Hemostatics')).toEqual(['D27.505.954.502.270.463']);
    expect(result.reasons.size).toBe(0);
  });

  test('限定語に翻訳された語には不一致の descriptor の階層を返さず名前を理由に含める', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { idlist: ['81000453', '68004813'],
        querytranslation: '"epidemiology"[Subheading]' } }))
      .mockResolvedValueOnce(jsonResponse({ result: { uids: ['81000453', '68004813'],
        '81000453': { ds_recordtype: 'qualifier', ds_meshui: 'Q000453',
          ds_meshterms: ['epidemiology', 'epidemics', 'incidence'], ds_idxlinks: [{ treenum: 'Y09.010' }] },
        '68004813': { ds_recordtype: 'descriptor', ds_meshui: 'D004813',
          ds_meshterms: ['Epidemiology', 'Social Epidemiology'], ds_idxlinks: [{ treenum: 'H02.403.720.500' }] },
      } }));
    const result = await fetchMeshTreeNumbers(['Incidence'], { fetch });
    expect(result.trees.size).toBe(0);
    expect(result.reasons.get('Incidence')).toBe('候補の descriptor が語と一致しない（Epidemiology）');
  });

  test('薬理作用だけなら descriptor が無い理由に record type を含める', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { idlist: ['82006490'] } }))
      .mockResolvedValueOnce(jsonResponse({ result: { uids: ['82006490'],
        '82006490': { ds_recordtype: 'pharmacological-action', ds_meshui: 'D006490',
          ds_meshterms: ['Hemostatics'], ds_idxlinks: [{ treenum: 'D006490' }] },
      } }));
    const result = await fetchMeshTreeNumbers(['Hemostatics'], { fetch });
    expect(result.trees.size).toBe(0);
    expect(result.reasons.get('Hemostatics')).toBe('候補 1 件に descriptor が無い（pharmacological-action）');
  });

  test.each([[[]], [['1']]])('候補の要約が全部または一部欠けたら理由を返す: %j', async (uids) => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { idlist: ['1', '2'] } }))
      .mockResolvedValueOnce(jsonResponse(meshSummary(uids.map((uid) => ({ uid, terms: ['Term'], treenums: ['C01'] })))));
    const result = await fetchMeshTreeNumbers(['Term'], { fetch });
    expect(result.trees.size).toBe(0);
    expect(result.reasons.get('Term')).toBe('候補の要約が返らなかった');
  });

  test('語に一致する descriptor が複数なら階層を選ばず、名前を先頭 3 件まで示す', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { idlist: ['1', '2', '3', '4'] } }))
      .mockResolvedValueOnce(jsonResponse(meshSummary(['A', 'B', 'C', 'D'].map((name, index) => ({
        uid: String(index + 1), terms: [name, 'Term'], treenums: ['C01'],
      })))));
    const result = await fetchMeshTreeNumbers(['Term'], { fetch });
    expect(result.trees.size).toBe(0);
    expect(result.reasons.get('Term')).toBe('語に一致する descriptor が複数ある（A, B, C, …）');
  });

  test('候補数や共有 UID によらず検索 3 回と要約 1 回で全候補を重複なく取得する', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { idlist: ['82006490', '68006490', '81000453'] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { idlist: ['68006490'] } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { idlist: ['68003930'] } }))
      .mockResolvedValueOnce(jsonResponse({ result: { uids: ['82006490', '68006490', '81000453', '68003930'],
        '82006490': { ds_recordtype: 'pharmacological-action', ds_meshterms: ['Hemostatics'], ds_idxlinks: [{ treenum: 'D006490' }] },
        '68006490': { ds_recordtype: 'descriptor', ds_meshterms: [' Hemostatics ', ' Antihemorrhagics '], ds_idxlinks: [{ treenum: 'D27.505.954.502.270.463' }] },
        '81000453': { ds_recordtype: 'qualifier', ds_meshterms: ['epidemiology'], ds_idxlinks: [{ treenum: 'Y09.010' }] },
        '68003930': { ds_recordtype: 'descriptor', ds_meshterms: ['Diabetic Retinopathy'], ds_idxlinks: [{ treenum: 'C11.768.257' }] },
      } }));
    const result = await fetchMeshTreeNumbers([' Hemostatics ', 'antihemorrhagics', 'Diabetic Retinopathy', 'Hemostatics'], {
      fetch, rateLimiter: { acquire: async () => undefined },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    const urls = fetch.mock.calls.map(([url]) => new URL(url as string));
    for (const url of urls.slice(0, 3)) {
      expect(url.pathname).toContain('esearch.fcgi');
      expect(url.searchParams.get('retmax')).toBe('20');
    }
    expect(urls[3]!.pathname).toContain('esummary.fcgi');
    expect(urls[3]!.searchParams.get('id')?.split(',')).toEqual(['82006490', '68006490', '81000453', '68003930']);
    expect([...result.trees]).toEqual([
      ['Hemostatics', ['D27.505.954.502.270.463']], ['antihemorrhagics', ['D27.505.954.502.270.463']],
      ['Diabetic Retinopathy', ['C11.768.257']],
    ]);
    expect(result.reasons.size).toBe(0);
  });

  test('全 descriptor が解決不能なら esummary を呼ばず空 Map', async () => {
    const fetch = jest.fn(async () => jsonResponse({ esearchresult: { idlist: [] } }));
    const result = await fetchMeshTreeNumbers(['X', 'Y'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.trees.size).toBe(0);
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
    expect(result.trees.size).toBe(0);
    expect(result.reasons.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('esearch レスポンスが esearchresult / idlist を欠いても 該当なし扱いで Map に入らない', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({});
      }
      return jsonResponse(SUMMARY_ASTHMA);
    });
    const result = await fetchMeshTreeNumbers(['X'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.trees.size).toBe(0);
  });

  test('esearch で UID が解決したが esummary に tree number が無い descriptor は Map に入らない', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1'] } });
      }
      // ds_idxlinks が空 = tree number 無し（例: 最上位カテゴリや索引リンク未整備）
      return jsonResponse({ result: { uids: ['1'], '1': { ds_recordtype: 'descriptor', ds_meshterms: ['X'], ds_idxlinks: [] } } });
    });
    const result = await fetchMeshTreeNumbers(['X'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.trees.size).toBe(0);
    expect(result.reasons.get('X')).toBe('descriptor に tree number が無い');
  });
});

describe('レートリミッタ（issue #58 chunk 3a フォローアップ）', () => {
  // mesh.ts は eutils.ts と同じホスト（eutils.ncbi.nlm.nih.gov）を叩くため、NCBI 側では
  // 同じ 3/10 req/s の枠を共有している。esearch 側だけをペーシングしても、mesh.ts が
  // 無防備に飛ばせば同じ枠を一緒に超過してしまうため、esearch(db=mesh) と esummary の
  // どちらも fetch 前に acquire() を通ることを固定する。

  test('esearch(db=mesh) は fetch 前に rateLimiter.acquire() を呼ぶ', async () => {
    const calls: string[] = [];
    const fetch = jest.fn(async () => {
      calls.push('fetch');
      return jsonResponse({ esearchresult: { idlist: ['1001'] } });
    });
    const rateLimiter: RateLimiter = {
      acquire: jest.fn(async () => {
        calls.push('acquire');
      }),
    };
    await fetchMeshTreeNumbers(['Asthma'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
      rateLimiter,
    });
    // esearch → esummary の 2 回とも acquire が fetch の直前に挟まる。
    expect(calls).toEqual(['acquire', 'fetch', 'acquire', 'fetch']);
  });

  test('descriptor の数だけ esearch 側の acquire() が呼ばれる（N descriptor → N 回）', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1'] } });
      }
      return jsonResponse(SUMMARY_ASTHMA);
    });
    const acquire = jest.fn().mockResolvedValue(undefined);
    await fetchMeshTreeNumbers(['Asthma', 'Bronchitis', 'Pneumonia'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
      rateLimiter: { acquire },
    });
    // esearch 3 回（distinct descriptor ごとに逐次）+ esummary 1 回（バッチ）= 4 回。
    expect(acquire).toHaveBeenCalledTimes(4);
  });

  test('deps.rateLimiter を渡すと、共有バケットではなくそちらが使われる', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1'] } });
      }
      return jsonResponse(SUMMARY_ASTHMA);
    });
    const acquire = jest.fn().mockResolvedValue(undefined);
    const withoutApiKeySpy = jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire');
    await fetchMeshTreeNumbers(['Asthma'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
      rateLimiter: { acquire },
    });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(withoutApiKeySpy).not.toHaveBeenCalled();
    withoutApiKeySpy.mockRestore();
  });

  test('apiKey 無しは esearch と同じ共有 withoutApiKey バケットを、apiKey 有りは withApiKey バケットを使う（枠を分裂させない）', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1'] } });
      }
      return jsonResponse(SUMMARY_ASTHMA);
    });
    const withoutApiKeySpy = jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire');
    const withApiKeySpy = jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire');

    await fetchMeshTreeNumbers(['Asthma'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(withoutApiKeySpy).toHaveBeenCalledTimes(2); // esearch + esummary
    expect(withApiKeySpy).not.toHaveBeenCalled();

    await fetchMeshTreeNumbers(['Asthma'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
      apiKey: 'secret',
    });
    expect(withApiKeySpy).toHaveBeenCalledTimes(2);
    expect(withoutApiKeySpy).toHaveBeenCalledTimes(2); // 増えていない

    withoutApiKeySpy.mockRestore();
    withApiKeySpy.mockRestore();
  });
});


describe('resolveMeshDescriptors', () => {
  test('空の見出しだけなら通信しない', async () => {
    const fetchMock = jest.fn();
    expect(await resolveMeshDescriptors(['', '  '], { fetch: fetchMock })).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
  const records = {
    '68009203': { ds_recordtype: 'descriptor', ds_meshui: 'D009203', ds_meshterms: ['Myocardial Infarction', 'Infarction, Myocardial', 'Heart Attack'] },
    '68062789': { ds_recordtype: 'descriptor', ds_meshui: 'D062789', ds_meshterms: ['Tobacco Products', 'Products, Tobacco'] },
    '68014026': { ds_recordtype: 'descriptor', ds_meshui: 'D014026', ds_meshterms: ['Nicotiana', 'Tobacco Plant'] },
    '68009369': { ds_recordtype: 'descriptor', ds_meshterms: ['Neoplasms'] },
  };
  test.each([
    ['Heart Attack', ['68009203'], ['Myocardial Infarction'], false],
    ['Infarction, Myocardial', ['68009203'], ['Myocardial Infarction'], false],
    ['Tobacco', ['68062789', '68014026'], ['Tobacco Products', 'Nicotiana'], true],
    ['Neoplasms', ['68009369'], ['Neoplasms'], false],
  ] as const)('%s を正式名に解決し、URL・共通パラメータ・レート制限を適用する', async (term, ids, headings, fallback) => {
    const fetchMock = jest.fn();
    if (fallback) fetchMock.mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0', warninglist: { quotedphrasesnotfound: [term] } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ esearchresult: { count: String(ids.length), idlist: ids } }))
      .mockResolvedValueOnce(jsonResponse({ result: { uids: ids, ...records } }));
    const rateLimiter = { acquire: jest.fn().mockResolvedValue(undefined) } as unknown as RateLimiter;
    const result = await resolveMeshDescriptors([` ${term} `, term, '', '  '], {
      fetch: fetchMock, rateLimiter, tool: 'test', apiKey: 'fake-key', email: 'test@example.com',
    });
    expect([...result]).toEqual([[term, { status: 'resolved', headings }]]);
    expect(fetchMock).toHaveBeenCalledTimes(fallback ? 3 : 2);
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(fetchMock.mock.calls.length);
    const urls = fetchMock.mock.calls.map((call) => new URL(call[0] as string));
    for (const url of urls) {
      expect(url.searchParams.get('db')).toBe('mesh');
      expect(url.searchParams.get('retmode')).toBe('json');
      expect(url.searchParams.get('tool')).toBe('test');
      expect(url.searchParams.get('api_key')).toBe('fake-key');
      expect(url.searchParams.get('email')).toBe('test@example.com');
    }
    expect(urls[0]!.searchParams.get('term')).toBe(`"${term}"[mh]`);
    for (const url of urls.slice(0, -1)) expect(url.searchParams.get('retmax')).toBe('20');
    if (fallback) expect(urls[1]!.searchParams.get('term')).toBe(`${term}[mh]`);
    expect(urls[urls.length - 1]!.pathname).toContain('esummary.fcgi');
    expect(urls[urls.length - 1]!.searchParams.get('id')).toBe(ids.join(','));
  });

  test.each([
    { count: '0', errorlist: { phrasesnotfound: ['Diabetic Retinopathy, Proliferative[mh]'] } },
    { count: '1', idlist: ['68009203'], errorlist: { phrasesnotfound: ['Diabetic Retinopathy, Proliferative[mh]'] } },
    { count: '0' },
  ])('引用符なしの未解決応答 %j は missing にする', async (esearchresult) => {
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0' } }))
      .mockResolvedValueOnce(jsonResponse({ esearchresult }));
    expect((await resolveMeshDescriptors(['Diabetic Retinopathy, Proliferative'], { fetch: fetchMock })).get('Diabetic Retinopathy, Proliferative')).toEqual({ status: 'missing' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    { ERROR: '失敗' }, {},
    { esearchresult: { ERROR: '失敗', count: '1' } },
    { esearchresult: { count: '1', errorlist: { fieldsnotfound: ['mh'] } } },
    ...[undefined, '', '-1', 'NaN', '1.5', 1, '9007199254740992'].map((count) => ({ esearchresult: { count } })),
    { esearchresult: { count: '1', idlist: [] } },
  ])('検索エラー %j は初回・再検索とも unknown にする', async (json) => {
    for (const fallback of [false, true]) {
      const fetchMock = jest.fn();
      if (fallback) fetchMock.mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0' } }));
      fetchMock.mockResolvedValueOnce(jsonResponse(json));
      expect((await resolveMeshDescriptors(['Term'], { fetch: fetchMock })).get('Term')).toEqual({ status: 'unknown' });
    }
  });

  test.each([
    {}, { ERROR: '失敗' }, { result: { ERROR: '失敗' } }, { result: { uids: [] } },
    { result: { uids: ['1'], '1': { ds_recordtype: 'supplemental', ds_meshterms: ['Term'] } } },
    ...[[], [' '], [42], 'Term'].map((ds_meshterms) => ({ result: { uids: ['1'], '1': { ds_recordtype: 'descriptor', ds_meshterms } } })),
    { result: { uids: ['1'], '1': { error: '失敗' } } },
    { result: { uids: ['1'], '1': { ERROR: '失敗', ds_recordtype: 'descriptor', ds_meshterms: ['Term'] } } },
    { result: { uids: '1', '1': { ds_recordtype: 'descriptor', ds_meshterms: ['Term'] } } },
  ])('要約に正式名が無い・失敗した場合 %j は unknown にする', async (summary) => {
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['1'] } }))
      .mockResolvedValueOnce(jsonResponse(summary));
    expect((await resolveMeshDescriptors(['Term'], { fetch: fetchMock })).get('Term')).toEqual({ status: 'unknown' });
  });

  test('要約の uids 順で空白と正式名の重複を除く', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '3', idlist: ['1', '2', '3'] } }))
      .mockResolvedValueOnce(jsonResponse({ result: { uids: ['3', '2', '1'],
        '1': { ds_recordtype: 'descriptor', ds_meshterms: [' A '] },
        '2': { ds_recordtype: 'descriptor', ds_meshterms: ['B'] },
        '3': { ds_recordtype: 'descriptor', ds_meshterms: ['A'] } } }));
    expect((await resolveMeshDescriptors(['Term'], { fetch: fetchMock })).get('Term')).toEqual({ status: 'resolved', headings: ['A', 'B'] });
  });

  test.each(['search', 'fallback', 'summary'])('%s の HTTP・通信失敗をリトライし、失敗後は unknown にする', async (stage) => {
    for (const kind of ['network', 'http', '400']) {
      const fetchMock = jest.fn();
      if (stage === 'fallback') fetchMock.mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '0' } }));
      if (stage === 'summary') fetchMock.mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['1'] } }));
      if (kind === 'network') fetchMock.mockRejectedValue(new TypeError('通信失敗'));
      else fetchMock.mockResolvedValue(errorResponse(kind === '400' ? 400 : 503));
      const rateLimiter = { acquire: jest.fn().mockResolvedValue(undefined) } as unknown as RateLimiter;
      expect((await resolveMeshDescriptors(['Term'], { fetch: fetchMock, rateLimiter, maxRetries: 2, sleep: async () => {} })).get('Term')).toEqual({ status: 'unknown' });
      expect(fetchMock).toHaveBeenCalledTimes((stage === 'search' ? 0 : 1) + 3);
      expect(rateLimiter.acquire).toHaveBeenCalledTimes(fetchMock.mock.calls.length);
    }
  });

  test('検索と要約がリトライで成功すれば正式名を返す', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(jsonResponse({ esearchresult: { count: '1', idlist: ['68009203'] } }))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(jsonResponse({ result: { uids: ['68009203'], ...records } }));
    const rateLimiter = { acquire: jest.fn().mockResolvedValue(undefined) } as unknown as RateLimiter;
    expect((await resolveMeshDescriptors(['Heart Attack'], { fetch: fetchMock, rateLimiter, sleep: async () => {} })).get('Heart Attack')).toEqual({ status: 'resolved', headings: ['Myocardial Infarction'] });
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(4);
  });
});
