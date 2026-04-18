import { resolveRisEntry } from './resolveRisEntry';
import type { RisEntry } from './parseRis';

function entry(overrides: Partial<RisEntry> & { tags?: Record<string, string[]> }): RisEntry {
  return {
    tags: {},
    title: 'title',
    year: 2020,
    originalDb: null,
    doi: null,
    ...overrides,
  };
}

function makeDeps(esearchResponse: { count: string; idlist: string[] }): Parameters<typeof resolveRisEntry>[1] {
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ esearchresult: esearchResponse }),
    text: async () => JSON.stringify({ esearchresult: esearchResponse }),
  } as Response);
  return { fetch };
}

describe('resolveRisEntry', () => {
  test('DB=PubMed + AN=数字 → ris_pubmed', async () => {
    const result = await resolveRisEntry(
      entry({ originalDb: 'PubMed', tags: { AN: ['12345678'] } }),
      makeDeps({ count: '0', idlist: [] })
    );
    expect(result.ingestFormat).toBe('ris_pubmed');
    expect(result.pmid).toBe('12345678');
  });

  test('DB=Scopus でも AN=数字なら ris_pmid_field', async () => {
    const result = await resolveRisEntry(
      entry({ originalDb: 'Scopus', tags: { AN: ['777'] } }),
      makeDeps({ count: '0', idlist: [] })
    );
    expect(result.ingestFormat).toBe('ris_pmid_field');
    expect(result.pmid).toBe('777');
    expect(result.originalDb).toBe('Scopus');
  });

  test('AN が非数字でも DOI で解決できれば ris_doi_resolved', async () => {
    const result = await resolveRisEntry(
      entry({ doi: '10.1/x', tags: { AN: ['NON-NUMERIC'] } }),
      makeDeps({ count: '1', idlist: ['999'] })
    );
    expect(result.ingestFormat).toBe('ris_doi_resolved');
    expect(result.pmid).toBe('999');
  });

  test('DOI も解決できなければ ris_no_pmid', async () => {
    const result = await resolveRisEntry(
      entry({ doi: '10.1/x' }),
      makeDeps({ count: '0', idlist: [] })
    );
    expect(result.ingestFormat).toBe('ris_no_pmid');
    expect(result.pmid).toBeNull();
  });

  test('DOI すら無ければ ris_no_pmid', async () => {
    const result = await resolveRisEntry(entry({}), makeDeps({ count: '0', idlist: [] }));
    expect(result.ingestFormat).toBe('ris_no_pmid');
  });

  test('DB=pubmed（小文字）も扱う', async () => {
    const result = await resolveRisEntry(
      entry({ originalDb: 'pubmed', tags: { AN: ['1'] } }),
      makeDeps({ count: '0', idlist: [] })
    );
    expect(result.ingestFormat).toBe('ris_pubmed');
  });

  test('DB=PubMed でも AN が非数字なら PMID 直接は使えず DOI フォールバック', async () => {
    const result = await resolveRisEntry(
      entry({ originalDb: 'PubMed', tags: { AN: ['non'] }, doi: '10.1/x' }),
      makeDeps({ count: '1', idlist: ['42'] })
    );
    expect(result.ingestFormat).toBe('ris_doi_resolved');
    expect(result.pmid).toBe('42');
  });
});
