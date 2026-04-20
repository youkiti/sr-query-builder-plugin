import { fetchMeshTreeNumbers, parseMeshTreeXml } from './mesh';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function xmlResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => body,
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

const MESH_XML_ASTHMA = `<?xml version="1.0"?>
<DescriptorRecordSet>
  <DescriptorRecord>
    <DescriptorName><String>Asthma</String></DescriptorName>
    <TreeNumberList>
      <TreeNumber>C08.127.108</TreeNumber>
      <TreeNumber>C08.381.495.108</TreeNumber>
    </TreeNumberList>
  </DescriptorRecord>
</DescriptorRecordSet>`;

const MESH_XML_MULTI = `<?xml version="1.0"?>
<DescriptorRecordSet>
  <DescriptorRecord>
    <DescriptorName><String>Asthma</String></DescriptorName>
    <TreeNumberList><TreeNumber>C08.127.108</TreeNumber></TreeNumberList>
  </DescriptorRecord>
  <DescriptorRecord>
    <DescriptorName><String>Bronchitis</String></DescriptorName>
    <TreeNumberList><TreeNumber>C08.127.108.562</TreeNumber></TreeNumberList>
  </DescriptorRecord>
</DescriptorRecordSet>`;

describe('parseMeshTreeXml', () => {
  test('Descriptor と TreeNumber を抽出する', () => {
    const out = parseMeshTreeXml(MESH_XML_ASTHMA);
    expect(out).toEqual([
      { descriptor: 'Asthma', treeNumbers: ['C08.127.108', 'C08.381.495.108'] },
    ]);
  });

  test('TreeNumber が空テキストのものは除外される', () => {
    const out = parseMeshTreeXml(
      `<?xml version="1.0"?>
<DescriptorRecordSet>
  <DescriptorRecord>
    <DescriptorName><String>Foo</String></DescriptorName>
    <TreeNumberList>
      <TreeNumber>   </TreeNumber>
      <TreeNumber>Z01</TreeNumber>
    </TreeNumberList>
  </DescriptorRecord>
</DescriptorRecordSet>`
    );
    expect(out[0]!.treeNumbers).toEqual(['Z01']);
  });

  test('DescriptorName が無いものは descriptor=null', () => {
    const out = parseMeshTreeXml(
      `<?xml version="1.0"?>
<DescriptorRecordSet>
  <DescriptorRecord>
    <TreeNumberList><TreeNumber>A01</TreeNumber></TreeNumberList>
  </DescriptorRecord>
</DescriptorRecordSet>`
    );
    expect(out[0]!.descriptor).toBeNull();
  });
});

describe('fetchMeshTreeNumbers', () => {
  test('空配列 → 空 Map、fetch は呼ばれない', async () => {
    const fetch = jest.fn();
    const result = await fetchMeshTreeNumbers([], { fetch });
    expect(result.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('descriptor ごとに esearch → efetch(1 回まとめて) を呼び、Map を返す', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi') && url.includes('term=Asthma%5Bmh%5D')) {
        return jsonResponse({ esearchresult: { idlist: ['1001'] } });
      }
      if (url.includes('esearch.fcgi') && url.includes('term=Bronchitis%5Bmh%5D')) {
        return jsonResponse({ esearchresult: { idlist: ['1002'] } });
      }
      if (url.includes('efetch.fcgi') && url.includes('db=mesh')) {
        expect(url).toContain('id=1001%2C1002');
        return xmlResponse(MESH_XML_MULTI);
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
      return xmlResponse(MESH_XML_ASTHMA);
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
      return xmlResponse(MESH_XML_ASTHMA);
    });
    const result = await fetchMeshTreeNumbers(['Unknown'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.size).toBe(0);
  });

  test('esearch が 2 件以上返した（曖昧）descriptor も Map に入らない', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1', '2'] } });
      }
      return xmlResponse(MESH_XML_ASTHMA);
    });
    const result = await fetchMeshTreeNumbers(['Ambiguous'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.size).toBe(0);
  });

  test('全 descriptor が解決不能なら efetch を呼ばず空 Map', async () => {
    const fetch = jest.fn(async () => jsonResponse({ esearchresult: { idlist: [] } }));
    const result = await fetchMeshTreeNumbers(['X', 'Y'], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.size).toBe(0);
    expect((fetch as jest.Mock).mock.calls.some((c) => (c[0] as string).includes('efetch'))).toBe(false);
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

  test('efetch が 5xx を返したら EutilsError', async () => {
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
    ).rejects.toThrow('mesh efetch failed');
  });

  test('apiKey / email / tool は共通パラメータで両 API に載る', async () => {
    const calls: string[] = [];
    const fetch = jest.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1'] } });
      }
      return xmlResponse(MESH_XML_ASTHMA);
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
      return xmlResponse(MESH_XML_ASTHMA);
    });
    const result = await fetchMeshTreeNumbers(['X'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.size).toBe(0);
  });

  test('esearch で UID が解決したが DescriptorName が null の record は Map に入らない', async () => {
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({ esearchresult: { idlist: ['1'] } });
      }
      return xmlResponse(
        `<?xml version="1.0"?><DescriptorRecordSet><DescriptorRecord><TreeNumberList><TreeNumber>A01</TreeNumber></TreeNumberList></DescriptorRecord></DescriptorRecordSet>`
      );
    });
    const result = await fetchMeshTreeNumbers(['X'], {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.size).toBe(0);
  });
});
