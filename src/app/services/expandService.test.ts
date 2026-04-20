import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import type { LLMProvider } from '@/lib/llm';
import {
  createStore,
  type AppState,
  type BlocksDraft,
  type ProtocolDraft,
} from '../store';
import {
  fetchBoundaryCandidates,
  recordDecision,
  type ExpandServiceDeps,
} from './expandService';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function textResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => ({}),
  } as Response;
}

function makeProtocolDraft(overrides: Partial<ProtocolDraft> = {}): ProtocolDraft {
  return {
    frameworkType: 'pico',
    researchQuestion: 'RQ',
    inclusionCriteria: 'inc',
    exclusionCriteria: 'exc',
    studyDesign: 'RCT',
    sourceType: 'manual',
    sourceFilename: null,
    rawTextRef: null,
    rawTextPreview: 'プレビュー',
    rawTextInline: '本文',
    ...overrides,
  };
}

function makeBlocksDraft(): BlocksDraft {
  return {
    blocks: [{ blockLabel: 'P', description: 'pop', aiGenerated: true, note: '' }],
    combinationExpression: '#1',
  };
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    route: 'expand',
    project: {
      projectId: 'p',
      spreadsheetId: 'SHEET',
      driveFolderId: 'D',
      title: 'T',
    },
    cumulativeCostUsd: null,
    blocksDraft: makeBlocksDraft(),
    protocolDraft: makeProtocolDraft(),
    currentProtocolVersion: 1,
    currentFormulaVersionId: 'v1',
    currentFormulaMarkdown:
      '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n#2 children[tiab]\n#3 #1 AND #2\n```\n',
    ...overrides,
  };
}

function mockProvider(json: string): LLMProvider {
  return {
    providerId: 'gemini',
    model: 'test',
    chat: async () => ({ text: json, tokensIn: null, tokensOut: null, raw: {} }),
  };
}

function buildEfetchXml(pmids: Array<{ pmid: string; title: string; year?: number }>): string {
  const articles = pmids
    .map(
      (p) => `
    <PubmedArticle>
      <MedlineCitation>
        <PMID>${p.pmid}</PMID>
        <Article>
          <ArticleTitle>${p.title}</ArticleTitle>
          <Journal>
            <JournalIssue>
              <PubDate><Year>${p.year ?? 2020}</Year></PubDate>
            </JournalIssue>
          </Journal>
        </Article>
      </MedlineCitation>
    </PubmedArticle>`
    )
    .join('\n');
  return `<?xml version="1.0"?><PubmedArticleSet>${articles}</PubmedArticleSet>`;
}

function emptyDeps(
  store: ReturnType<typeof createStore>,
  provider: LLMProvider = mockProvider('{}')
): ExpandServiceDeps {
  const noop = jest.fn();
  return {
    google: {
      fetch: noop as unknown as typeof fetch,
      getAccessToken: jest.fn().mockResolvedValue('t'),
    },
    eutils: {
      fetch: noop as unknown as typeof fetch,
      sleep: async () => undefined,
      maxRetries: 0,
    },
    store,
    llmFactory: { forPurpose: () => provider },
  };
}

function seedRowWithPmid(pmid: string, isValid = true): string[] {
  const row = SHEET_HEADERS.SeedPapers.map(() => '');
  row[SHEET_HEADERS.SeedPapers.indexOf('pmid')] = pmid;
  row[SHEET_HEADERS.SeedPapers.indexOf('is_valid')] = isValid ? 'true' : 'false';
  return row;
}

function formulaVersionRow(
  versionId: string,
  protocolVersion: string,
  formulaMd: string
): string[] {
  return SHEET_HEADERS.FormulaVersions.map((key) => {
    if (key === 'version_id') return versionId;
    if (key === 'protocol_version') return protocolVersion;
    if (key === 'formula_md') return formulaMd;
    if (key === 'created_by') return 'ai_draft';
    if (key === 'created_at') return '2026';
    return '';
  });
}

function protocolRow(version: string, overrides: Partial<Record<string, string>> = {}): string[] {
  const base: Record<string, string> = {
    version,
    framework_type: 'pico',
    research_question: 'RQ from sheet',
    inclusion_criteria: 'inc from sheet',
    exclusion_criteria: 'exc from sheet',
    study_design: 'RCT',
    block_count: '1',
    combination_expression: '#1',
    source_type: 'manual',
    source_filename: '',
    raw_text_ref: '',
    raw_text_preview: '',
    raw_text_inline: '',
    created_at: '2026',
    created_by: 'me@example.com',
  };
  return SHEET_HEADERS.Protocol.map((key) => overrides[key] ?? base[key] ?? '');
}

describe('fetchBoundaryCandidates', () => {
  test('プロジェクト未選択なら例外', async () => {
    const store = createStore(makeState({ project: null }));
    await expect(fetchBoundaryCandidates(emptyDeps(store))).rejects.toThrow('プロジェクト');
  });

  test('protocolDraft 未設定なら例外', async () => {
    const store = createStore(
      makeState({ protocolDraft: null, currentFormulaVersionId: null, currentProtocolVersion: null })
    );
    await expect(fetchBoundaryCandidates(emptyDeps(store))).rejects.toThrow('protocolDraft');
  });

  test('検索式未生成なら例外', async () => {
    const store = createStore(makeState({ currentFormulaMarkdown: null }));
    await expect(fetchBoundaryCandidates(emptyDeps(store))).rejects.toThrow('検索式ドラフト');
  });

  test('展開結果が空なら例外', async () => {
    const store = createStore(
      makeState({ currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n\n```\n' })
    );
    await expect(fetchBoundaryCandidates(emptyDeps(store))).rejects.toThrow('展開結果が空');
  });

  test('既存 seed を除外した上位候補を skill に渡し、結果を view に変換する', async () => {
    const store = createStore(makeState());
    const googleFetch = jest.fn();
    googleFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/values/SeedPapers')) {
        return jsonResponse({
          values: [SHEET_HEADERS.SeedPapers, seedRowWithPmid('111', true)],
        });
      }
      return jsonResponse({});
    });
    const eutilsFetch = jest.fn();
    eutilsFetch.mockImplementation(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({
          esearchresult: { count: '1000', idlist: ['111', '222', '333', '444'] },
        });
      }
      if (url.includes('efetch.fcgi')) {
        return textResponse(
          buildEfetchXml([
            { pmid: '222', title: 'Paper 222' },
            { pmid: '333', title: 'Paper 333' },
            { pmid: '444', title: 'Paper 444' },
          ])
        );
      }
      return jsonResponse({});
    });
    const forPurpose = jest.fn().mockReturnValue(
      mockProvider(
        JSON.stringify({
          picks: [
            { pmid: '222', reason: 'subset match' },
            { pmid: '333', reason: 'intervention varies' },
          ],
        })
      )
    );
    const result = await fetchBoundaryCandidates({
      google: {
        fetch: googleFetch as unknown as typeof fetch,
        getAccessToken: jest.fn().mockResolvedValue('t'),
      },
      eutils: {
        fetch: eutilsFetch as unknown as typeof fetch,
        sleep: async () => undefined,
        maxRetries: 0,
      },
      store,
      llmFactory: { forPurpose },
    });
    expect(result.totalHits).toBe(1000);
    expect(result.evaluatedCount).toBe(3);
    expect(result.candidates.map((c) => c.pmid)).toEqual(['222', '333']);
    expect(result.candidates[0]).toMatchObject({
      pmid: '222',
      title: 'Paper 222',
      reason: 'subset match',
    });
    expect(forPurpose).toHaveBeenCalledWith('pick_boundary');
  });

  test('新規候補が 0 件なら skill を呼ばず空の結果を返す', async () => {
    const store = createStore(makeState());
    const googleFetch = jest.fn();
    googleFetch.mockImplementation(async (url: string) => {
      if (url.includes('/values/SeedPapers')) {
        return jsonResponse({
          values: [SHEET_HEADERS.SeedPapers, seedRowWithPmid('111', true)],
        });
      }
      return jsonResponse({});
    });
    const eutilsFetch = jest.fn();
    eutilsFetch.mockImplementation(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({
          esearchresult: { count: '10', idlist: ['111'] },
        });
      }
      return jsonResponse({});
    });
    const forPurpose = jest.fn();
    const result = await fetchBoundaryCandidates({
      google: {
        fetch: googleFetch as unknown as typeof fetch,
        getAccessToken: jest.fn().mockResolvedValue('t'),
      },
      eutils: {
        fetch: eutilsFetch as unknown as typeof fetch,
        sleep: async () => undefined,
        maxRetries: 0,
      },
      store,
      llmFactory: { forPurpose },
    });
    expect(result.candidates).toEqual([]);
    expect(result.evaluatedCount).toBe(0);
    expect(result.totalHits).toBe(10);
    expect(forPurpose).not.toHaveBeenCalled();
  });

  test('efetch で取れなかった候補は candidates から除外される', async () => {
    const store = createStore(makeState());
    const googleFetch = jest.fn();
    googleFetch.mockImplementation(async (url: string) => {
      if (url.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [SHEET_HEADERS.SeedPapers] });
      }
      return jsonResponse({});
    });
    const eutilsFetch = jest.fn();
    eutilsFetch.mockImplementation(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({
          esearchresult: { count: '2', idlist: ['555', '666'] },
        });
      }
      return textResponse(buildEfetchXml([{ pmid: '666', title: 'Only 666' }]));
    });
    const result = await fetchBoundaryCandidates({
      google: {
        fetch: googleFetch as unknown as typeof fetch,
        getAccessToken: jest.fn().mockResolvedValue('t'),
      },
      eutils: {
        fetch: eutilsFetch as unknown as typeof fetch,
        sleep: async () => undefined,
        maxRetries: 0,
      },
      store,
      llmFactory: {
        forPurpose: () =>
          mockProvider(JSON.stringify({ picks: [{ pmid: '666', reason: 'ok' }] })),
      },
    });
    expect(result.candidates).toEqual([
      { pmid: '666', title: 'Only 666', year: 2020, reason: 'ok' },
    ]);
    expect(result.evaluatedCount).toBe(1);
  });

  test('retmax / skillCandidateLimit を反映する', async () => {
    const store = createStore(makeState());
    const googleFetch = jest.fn();
    googleFetch.mockImplementation(async (url: string) => {
      if (url.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [SHEET_HEADERS.SeedPapers] });
      }
      return jsonResponse({});
    });
    const eutilsFetch = jest.fn();
    eutilsFetch.mockImplementation(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        expect(url).toContain('retmax=5');
        return jsonResponse({
          esearchresult: { count: '100', idlist: ['1', '2', '3', '4', '5'] },
        });
      }
      if (url.includes('efetch.fcgi')) {
        expect(url).toContain('id=1%2C2');
        return textResponse(
          buildEfetchXml([
            { pmid: '1', title: 'p1' },
            { pmid: '2', title: 'p2' },
          ])
        );
      }
      return jsonResponse({});
    });
    await fetchBoundaryCandidates({
      google: {
        fetch: googleFetch as unknown as typeof fetch,
        getAccessToken: jest.fn().mockResolvedValue('t'),
      },
      eutils: {
        fetch: eutilsFetch as unknown as typeof fetch,
        sleep: async () => undefined,
        maxRetries: 0,
      },
      store,
      llmFactory: { forPurpose: () => mockProvider(JSON.stringify({ picks: [] })) },
      retmax: 5,
      skillCandidateLimit: 2,
    });
  });

  test('protocolDraft が無くても親 FormulaVersion と Protocol 行から候補取得できる', async () => {
    const store = createStore(
      makeState({
        protocolDraft: null,
        currentProtocolVersion: null,
        currentFormulaVersionId: 'v-from-history',
      })
    );
    const googleFetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/values/SeedPapers')) {
        return jsonResponse({ values: [SHEET_HEADERS.SeedPapers] });
      }
      if (url.includes('/values/FormulaVersions')) {
        return jsonResponse({
          values: [
            SHEET_HEADERS.FormulaVersions,
            formulaVersionRow(
              'v-from-history',
              '7',
              '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n#2 children[tiab]\n#3 #1 AND #2\n```\n'
            ),
          ],
        });
      }
      if (url.includes('/values/Protocol')) {
        return jsonResponse({
          values: [SHEET_HEADERS.Protocol, protocolRow('7')],
        });
      }
      return jsonResponse({});
    });
    const eutilsFetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('esearch.fcgi')) {
        return jsonResponse({
          esearchresult: { count: '10', idlist: ['222'] },
        });
      }
      return textResponse(buildEfetchXml([{ pmid: '222', title: 'Sheet-backed candidate' }]));
    });
    const provider: LLMProvider = {
      providerId: 'gemini',
      model: 'test',
      chat: jest.fn().mockResolvedValue({
        text: JSON.stringify({ picks: [{ pmid: '222', reason: 'sheet protocol used' }] }),
        tokensIn: null,
        tokensOut: null,
        raw: {},
      }),
    };
    const result = await fetchBoundaryCandidates({
      google: {
        fetch: googleFetch as unknown as typeof fetch,
        getAccessToken: jest.fn().mockResolvedValue('t'),
      },
      eutils: {
        fetch: eutilsFetch as unknown as typeof fetch,
        sleep: async () => undefined,
        maxRetries: 0,
      },
      store,
      llmFactory: { forPurpose: () => provider },
    });
    expect(result.candidates).toEqual([
      {
        pmid: '222',
        title: 'Sheet-backed candidate',
        year: 2020,
        reason: 'sheet protocol used',
      },
    ]);
    expect(provider.chat).toHaveBeenCalled();
  });
});

describe('recordDecision', () => {
  test('プロジェクト未選択なら例外', async () => {
    const store = createStore(makeState({ project: null }));
    await expect(
      recordDecision(
        { pmid: '222', title: null, year: null, decision: 'include', reason: 'r' },
        emptyDeps(store)
      )
    ).rejects.toThrow('プロジェクト');
  });

  test('include は is_valid=true、exclusion_reason=null', async () => {
    const store = createStore(makeState());
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
    const result = await recordDecision(
      { pmid: '222', title: 'T', year: 2021, decision: 'include', reason: 'looks good' },
      {
        google: {
          fetch: fetchMock as unknown as typeof fetch,
          getAccessToken: jest.fn().mockResolvedValue('t'),
        },
        eutils: {
          fetch: jest.fn() as unknown as typeof fetch,
          sleep: async () => undefined,
          maxRetries: 0,
        },
        store,
        llmFactory: { forPurpose: () => mockProvider('{}') },
        now: () => '2026-04-19T00:00:00.000Z',
      }
    );
    expect(result.seed.isValid).toBe(true);
    expect(result.seed.exclusionReason).toBeNull();
    expect(result.seed.userDecision).toBe('include');
    expect(result.seed.source).toBe('interactive');
    expect(result.seed.ingestFormat).toBe('interactive');
    expect(result.seed.decidedAt).toBe('2026-04-19T00:00:00.000Z');
    expect(result.seed.note).toBe('looks good');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      values: (string | number | boolean | null)[][];
    };
    const row = body.values[0]!;
    const map: Record<string, string | number | boolean | null> = {};
    SHEET_HEADERS.SeedPapers.forEach((k, i) => {
      map[k] = row[i] as string | number | boolean | null;
    });
    expect(map['pmid']).toBe('222');
    expect(map['source']).toBe('interactive');
    expect(map['is_valid']).toBe(true);
  });

  test('exclude は is_valid=false + user_removed', async () => {
    const store = createStore(makeState());
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
    const result = await recordDecision(
      { pmid: '333', title: null, year: null, decision: 'exclude', reason: '' },
      {
        google: {
          fetch: fetchMock as unknown as typeof fetch,
          getAccessToken: jest.fn().mockResolvedValue('t'),
        },
        eutils: {
          fetch: jest.fn() as unknown as typeof fetch,
          sleep: async () => undefined,
          maxRetries: 0,
        },
        store,
        llmFactory: { forPurpose: () => mockProvider('{}') },
      }
    );
    expect(result.seed.isValid).toBe(false);
    expect(result.seed.exclusionReason).toBe('user_removed');
    expect(result.seed.note).toBeNull();
  });

  test('maybe も is_valid=false + note 反映', async () => {
    const store = createStore(makeState());
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
    const result = await recordDecision(
      { pmid: '444', title: null, year: null, decision: 'maybe', reason: 'unsure' },
      {
        google: {
          fetch: fetchMock as unknown as typeof fetch,
          getAccessToken: jest.fn().mockResolvedValue('t'),
        },
        eutils: {
          fetch: jest.fn() as unknown as typeof fetch,
          sleep: async () => undefined,
          maxRetries: 0,
        },
        store,
        llmFactory: { forPurpose: () => mockProvider('{}') },
      }
    );
    expect(result.seed.isValid).toBe(false);
    expect(result.seed.userDecision).toBe('maybe');
    expect(result.seed.note).toBe('unsure');
  });

  test('now / newUuid 未指定でも動く（既定実装）', async () => {
    const store = createStore(makeState());
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
    const result = await recordDecision(
      { pmid: '555', title: null, year: null, decision: 'include', reason: '' },
      {
        google: {
          fetch: fetchMock as unknown as typeof fetch,
          getAccessToken: jest.fn().mockResolvedValue('t'),
        },
        eutils: {
          fetch: jest.fn() as unknown as typeof fetch,
          sleep: async () => undefined,
          maxRetries: 0,
        },
        store,
        llmFactory: { forPurpose: () => mockProvider('{}') },
      }
    );
    expect(typeof result.seed.decidedAt).toBe('string');
    expect(result.seed.decidedAt?.length).toBeGreaterThan(0);
  });
});
