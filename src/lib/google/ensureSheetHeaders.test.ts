import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { ensureSheetHeaders } from './ensureSheetHeaders';

function connection(header: readonly string[]) {
  return { fetch: jest.fn().mockResolvedValue({ ok: true, json: async () => ({ values: [header] }) }),
    getAccessToken: async () => 'fake' };
}

test.each(['FormulaVersions', 'LLMApiLog'] as const)('%s の古い見出しを一度だけ更新する', async (tab) => {
  const header = SHEET_HEADERS[tab];
  const deps = connection(header.slice(0, -3));
  await Promise.all([ensureSheetHeaders('sheet', tab, header, deps), ensureSheetHeaders('sheet', tab, header, deps)]);
  await ensureSheetHeaders('sheet', tab, header, deps);
  expect(deps.fetch).toHaveBeenCalledTimes(2);
  expect(deps.fetch.mock.calls[1]![1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ values: [header] }) });
});

test('新見出しなら更新せず、非 prefix の見出しも警告だけで維持する', async () => {
  const header = SHEET_HEADERS.FormulaVersions;
  const valid = connection(header);
  await ensureSheetHeaders('s', 'FormulaVersions', header, valid);
  expect(valid.fetch).toHaveBeenCalledTimes(1);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const invalid = connection(['unexpected']);
    await ensureSheetHeaders('s', 'FormulaVersions', header, invalid);
    expect(invalid.fetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
});

test.each(['read', 'write'] as const)('%s 失敗は警告して resolve し、次回は再試行する', async (failure) => {
  const header = SHEET_HEADERS.FormulaVersions;
  const deps = connection(header.slice(0, -3));
  if (failure === 'read') deps.fetch.mockRejectedValueOnce(new Error('秘密のトークン'));
  else deps.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ values: [header.slice(0, -3)] }) })
    .mockRejectedValueOnce(new Error('秘密のトークン'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await expect(ensureSheetHeaders('s', 'FormulaVersions', header, deps)).resolves.toBeUndefined();
    await expect(ensureSheetHeaders('s', 'FormulaVersions', header, deps)).resolves.toBeUndefined();
    const callCount = failure === 'read' ? 3 : 4;
    expect(deps.fetch).toHaveBeenCalledTimes(callCount);
    await ensureSheetHeaders('s', 'FormulaVersions', header, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(callCount);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('秘密のトークン');
  } finally { warn.mockRestore(); }
});

test.each(['FormulaVersions', 'LLMApiLog'] as const)('%s の確認では 1 行目だけを要求する', async (tab) => {
  const deps = connection(SHEET_HEADERS[tab]);
  await ensureSheetHeaders('sheet', tab, SHEET_HEADERS[tab], deps);
  expect(decodeURIComponent(deps.fetch.mock.calls[0]![0])).toBe(
    `https://sheets.googleapis.com/v4/spreadsheets/sheet/values/${tab}!1:1`
  );
});
