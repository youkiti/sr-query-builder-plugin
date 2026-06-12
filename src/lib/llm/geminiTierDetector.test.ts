import { detectGeminiTier, FREE_TIER_MODEL_ID } from './geminiTierDetector';

function makeFetch(status: number, body: unknown): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response);
}

function makeNetworkError(): typeof fetch {
  return jest.fn().mockRejectedValue(new Error('network error'));
}

describe('detectGeminiTier', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('空キーは unknown を返す', async () => {
    const fetchMock = jest.fn();
    await expect(detectGeminiTier('', fetchMock)).resolves.toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('HTTP 200 → paid', async () => {
    const fetchMock = makeFetch(200, { candidates: [] });
    await expect(detectGeminiTier('valid-key', fetchMock)).resolves.toBe('paid');
  });

  test('FAILED_PRECONDITION → free', async () => {
    const fetchMock = makeFetch(400, { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'Billing not enabled' } });
    await expect(detectGeminiTier('free-key', fetchMock)).resolves.toBe('free');
  });

  test('PERMISSION_DENIED → free', async () => {
    const fetchMock = makeFetch(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Permission denied' } });
    await expect(detectGeminiTier('free-key', fetchMock)).resolves.toBe('free');
  });

  test('HTTP 403 ステータスは status フィールドが無くても free', async () => {
    const fetchMock = makeFetch(403, {});
    await expect(detectGeminiTier('free-key', fetchMock)).resolves.toBe('free');
  });

  test('NOT_FOUND → free', async () => {
    const fetchMock = makeFetch(404, { error: { code: 404, status: 'NOT_FOUND', message: 'Model not found' } });
    await expect(detectGeminiTier('free-key', fetchMock)).resolves.toBe('free');
  });

  test('HTTP 404 ステータスは status フィールドが無くても free', async () => {
    const fetchMock = makeFetch(404, {});
    await expect(detectGeminiTier('free-key', fetchMock)).resolves.toBe('free');
  });

  test('INVALID_ARGUMENT（無効キー）→ unknown', async () => {
    const fetchMock = makeFetch(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid' } });
    await expect(detectGeminiTier('bad-key', fetchMock)).resolves.toBe('unknown');
  });

  test('RESOURCE_EXHAUSTED（通常のレートリミット）→ unknown', async () => {
    const fetchMock = makeFetch(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } });
    await expect(detectGeminiTier('paid-key', fetchMock)).resolves.toBe('unknown');
  });

  test('429 + 「free quota tier なし」メッセージ → free', async () => {
    const fetchMock = makeFetch(429, {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: "Gemini 3.5 Flash doesn't have a free quota tier. Please enable billing.",
      },
    });
    await expect(detectGeminiTier('free-key', fetchMock)).resolves.toBe('free');
  });

  test('429 + QuotaFailure（quotaValue "0"）→ free', async () => {
    const fetchMock = makeFetch(429, {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'You exceeded your current quota.',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              {
                quotaMetric:
                  'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count',
                quotaValue: '0',
              },
            ],
          },
        ],
      },
    });
    await expect(detectGeminiTier('free-key', fetchMock)).resolves.toBe('free');
  });

  test('ネットワークエラー → unknown', async () => {
    await expect(detectGeminiTier('any-key', makeNetworkError())).resolves.toBe('unknown');
  });

  test('レスポンスボディが JSON でない → unknown（クラッシュしない）', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: jest.fn().mockRejectedValue(new SyntaxError('invalid json')),
    } as unknown as Response);
    await expect(detectGeminiTier('key', fetchMock)).resolves.toBe('unknown');
  });

  test('FREE_TIER_MODEL_ID が定義されている', () => {
    expect(typeof FREE_TIER_MODEL_ID).toBe('string');
    expect(FREE_TIER_MODEL_ID.length).toBeGreaterThan(0);
  });
});
