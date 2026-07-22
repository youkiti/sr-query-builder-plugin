/**
 * 論文の方法（Methods）節に貼り付ける「検索式の下書きに生成 AI を使った」旨の
 * 定型文を組み立てる。#/export 画面のコピー用文案として使う。
 *
 * - モデル ID は FormulaVersions.model（= 実際に下書きを支援したモデル）を渡す。
 *   model 列導入前の旧バージョンでは null になるため、その場合は `{...}` の
 *   プレースホルダを残してユーザーに置き換えてもらう
 * - バージョンは manifest 由来の拡張機能バージョン
 */

export interface MethodsTextInput {
  /** 下書きを支援した LLM モデル ID（例: 'gemini-3.5-flash'）。不明なら null */
  model: string | null;
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
  const version = input.version ?? VERSION_PLACEHOLDER;
  const modelEn = input.model ?? MODEL_PLACEHOLDER_EN;
  const modelJa = input.model ?? MODEL_PLACEHOLDER_JA;
  return {
    en:
      `The PubMed search strategy was drafted with the assistance of a generative AI model (${modelEn}) ` +
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
export function getExtensionVersion(): string | null {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.getManifest) {
      return null;
    }
    const version = chrome.runtime.getManifest().version;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
}
