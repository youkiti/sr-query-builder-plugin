/**
 * 論文の方法（Methods）節に貼り付ける「検索式の下書きに生成 AI を使った」旨の
 * 定型文を組み立てる。#/export 画面のコピー用文案として使う。
 *
 * - モデル ID は保存版の modelsUsed を優先し、旧版では model を使う。
 *   model 列導入前の旧バージョンでは null になるため、その場合は `{...}` の
 *   プレースホルダを残してユーザーに置き換えてもらう
 * - 拡張バージョンは保存版を優先し、旧版では現在の manifest を使う。
 */

export interface MethodsTextInput {
  /** 下書きを支援した LLM モデル ID（例: 'gemini-3.5-flash'）。不明なら null */
  model: string | null;
  modelsUsed?: string | null;
  appVersion?: string | null;
  /** 拡張機能のバージョン（manifest.json の version）。取得できなければ null */
  version: string | null;
}

export interface MethodsTexts {
  en: string;
  ja: string;
}

/** model が不明なとき文中に残すプレースホルダ（英語文用） */
export const MODEL_PLACEHOLDER_EN = '{AI model}';
/** model が不明なとき文中に残すプレースホルダ（日本語文用） */
export const MODEL_PLACEHOLDER_JA = '{AI モデル名}';
/** version が取得できないとき文中に残すプレースホルダ */
export const VERSION_PLACEHOLDER = '{version}';

export function buildMethodsTexts(input: MethodsTextInput): MethodsTexts {
  const version = input.appVersion ?? input.version ?? VERSION_PLACEHOLDER;
  const models = input.modelsUsed?.split(';').filter(Boolean);
  const modelEn = models?.length ? models.join(', ') : input.model ?? MODEL_PLACEHOLDER_EN;
  const modelPhrase = models && models.length > 1 ? 'generative AI models' : 'a generative AI model';
  const modelJa = models?.length ? models.join('、') : input.model ?? MODEL_PLACEHOLDER_JA;
  return {
    en:
      `The PubMed search strategy was drafted with the assistance of ${modelPhrase} (${modelEn}) ` +
      `using sr-query-builder-plugin (version ${version}), an open-source browser extension for developing ` +
      'systematic review search strategies. All AI-generated output was reviewed, edited, and approved by the authors.',
    ja:
      `PubMed 検索式の下書きは、オープンソースのブラウザ拡張 sr-query-builder-plugin（バージョン ${version}）上で` +
      `生成 AI（${modelJa}）の支援を受けて作成し、著者が内容を確認・修正のうえ確定した。`,
  };
}

/**
 * 拡張機能自身のバージョンを manifest から取得する。
 * chrome API が無い環境（jsdom テスト等）では null を返す。
 */
export { getExtensionVersion } from '@/utils/extensionVersion';
