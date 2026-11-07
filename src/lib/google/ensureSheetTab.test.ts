// タブ作成の重複防止と失敗後の再試行を、偽の Sheets 通信で確認する。
import { ensureSheetTab } from './ensureSheetTab';

const headers = ['event', 'run_id'];
const response = (data: unknown = {}) => ({ ok: true, json: async () => data });
function connection(exists = false) {
  return { fetch: jest.fn().mockResolvedValue(response({ sheets: exists ? [{ properties: { title: 'OptimizationLog' } }] : [],
    values: [headers] })), getAccessToken: async () => 'fake' };
}
const ensure = (deps: ReturnType<typeof connection>) => ensureSheetTab('sheet', 'OptimizationLog', headers, deps);

test('既存タブの見出しがあるときは書き直さない', async () => {
  const deps = connection(true);
  await ensure(deps);
  expect(deps.fetch.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'GET', 'GET']);
  expect(deps.fetch.mock.calls[0]![0]).toContain('?fields=sheets.properties.title');
});

test('無いタブを作り、見出しを書く。並行呼び出しと後続呼び出しも共有する', async () => {
  const deps = connection();
  await Promise.all([ensure(deps), ensure(deps)]);
  await ensure(deps);
  expect(deps.fetch.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'POST', 'PUT']);
  expect(JSON.parse(deps.fetch.mock.calls[1]![1].body)).toEqual({ requests: [{ addSheet: { properties: { title: 'OptimizationLog' } } }] });
  expect(JSON.parse(deps.fetch.mock.calls[2]![1].body)).toEqual({ values: [headers] });
});

test.each(['確認', '作成', '見出し'])('%s の失敗後は再試行できる', async (failure) => {
  const deps = connection();
  if (failure !== '確認') {
    deps.fetch.mockResolvedValueOnce(response({ sheets: [] }));
  }
  if (failure === '見出し') {
    deps.fetch.mockResolvedValueOnce(response());
  }
  deps.fetch.mockRejectedValueOnce(new Error('失敗'));
  await expect(ensure(deps)).rejects.toThrow('失敗');
  if (failure === '見出し') {
    deps.fetch.mockResolvedValue(response({ sheets: [{ properties: { title: 'OptimizationLog' } }] }));
  }
  await expect(ensure(deps)).resolves.toBeUndefined();
  expect(deps.fetch.mock.calls[deps.fetch.mock.calls.length - 1]![1].method).toBe('PUT');
});

test('別端末による作成との競合だけは既存タブとして見出し確認へ進む', async () => {
  const deps = connection();
  deps.fetch.mockResolvedValueOnce(response({ sheets: [] }))
    .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'A sheet already exists' });
  await ensure(deps);
  expect(deps.fetch.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'POST', 'GET', 'GET']);
});

test('既に存在するという本文でも 400 以外は失敗として扱う', async () => {
  const deps = connection();
  deps.fetch.mockResolvedValueOnce(response({ sheets: [] }))
    .mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'already exists' });
  await expect(ensure(deps)).rejects.toMatchObject({ status: 403 });
});


test('既存タブの見出し確認が失敗したときも次の呼び出しで再試行する', async () => {
  const deps = connection(true);
  deps.fetch.mockResolvedValueOnce(response({ sheets: [{ properties: { title: 'OptimizationLog' } }] }))
    .mockRejectedValueOnce(new Error('確認失敗'));
  await expect(ensure(deps)).rejects.toThrow('確認失敗');
  await ensure(deps);
  expect(deps.fetch.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET']);
});


test.each([{ values: [] }, { values: [[]] }])('既存タブの１行目が空なら見出しを書く（%j）', async ({ values }) => {
  const deps = connection(true);
  deps.fetch.mockResolvedValueOnce(response({ sheets: [{ properties: { title: 'OptimizationLog' } }] }))
    .mockResolvedValueOnce(response({ values }));
  await ensure(deps);
  expect(deps.fetch.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'GET', 'PUT']);
  expect(deps.fetch.mock.calls[1]![0]).toContain('1%3A1');
  expect(JSON.parse(deps.fetch.mock.calls[2]![1].body)).toEqual({ values: [headers] });
});
