import { SHEET_HEADERS, SHEET_TABS } from './sheetsSchema';

describe('SHEET_TABS / SHEET_HEADERS', () => {
  test('9 タブが定義されている', () => {
    expect(SHEET_TABS).toHaveLength(9);
  });

  test('各タブのヘッダー配列は重複なし・空文字なし', () => {
    for (const tab of SHEET_TABS) {
      const headers = SHEET_HEADERS[tab];
      expect(headers.length).toBeGreaterThan(0);
      expect(new Set(headers).size).toBe(headers.length);
      for (const col of headers) {
        expect(col).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  test('Meta タブには project_id と drive_folder_id が含まれる', () => {
    expect(SHEET_HEADERS.Meta).toContain('project_id');
    expect(SHEET_HEADERS.Meta).toContain('drive_folder_id');
  });

  test('SeedPapers タブには ris_no_pmid 対応の列が含まれる', () => {
    expect(SHEET_HEADERS.SeedPapers).toContain('ingest_format');
    expect(SHEET_HEADERS.SeedPapers).toContain('exclusion_reason');
    expect(SHEET_HEADERS.SeedPapers).toContain('original_payload_ref');
  });
});
