/** 空の領域でも英語側に余分なキーを許さず、日本語の追加後はそのキー集合を要求する。 */
export type TranslatedMessages<T> = keyof T extends never
  ? Record<string, never>
  : Record<keyof T, string>;
