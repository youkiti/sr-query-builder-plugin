/**
 * skill が LLM から受け取った JSON 文字列をパースする。
 *
 * - Gemini の `responseMimeType: application/json` は時々前後に空白や
 *   ` ```json ... ``` ` のマークダウン装飾を含むため、最初に出てくる
 *   `{...}` ブロックを抽出してからパースする
 * - 失敗時は `SkillResponseError` を投げる
 */

export class SkillResponseError extends Error {
  readonly rawText: string;
  readonly skillName: string;
  constructor(message: string, skillName: string, rawText: string) {
    super(message);
    this.name = 'SkillResponseError';
    this.skillName = skillName;
    this.rawText = rawText;
  }
}

export function parseSkillJson<T>(text: string, skillName: string): T {
  const stripped = stripCodeFence(text).trim();
  if (stripped === '') {
    throw new SkillResponseError(`${skillName} のレスポンスが空です`, skillName, text);
  }
  try {
    return JSON.parse(stripped) as T;
  } catch (err) {
    throw new SkillResponseError(
      `${skillName} のレスポンスが JSON としてパースできません: ${(err as Error).message}`,
      skillName,
      text
    );
  }
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fenced && fenced[1] !== undefined) {
    return fenced[1];
  }
  return text;
}
