/**
 * RIS 形式のテキストをパースする。
 *
 * RIS レコード例：
 * ```
 * TY  - JOUR
 * DB  - PubMed
 * T1  - Title
 * AU  - Author
 * PY  - 2020
 * DO  - 10.1234/abc
 * AN  - 12345678
 * ER  -
 * ```
 *
 * - 各タグは 2 文字 + `  - `
 * - `ER  - ` 行でレコード終了
 *
 * requirements.md §4.3 の RIS ingest ロジックに合わせ、PMID 解決は
 * 別関数（resolveRisEntry）で行う。ここではタグのパースに専念。
 */

export interface RisEntry {
  /** 元 RIS のタグ → 値（複数値可）。キーは大文字に揃える */
  tags: Record<string, string[]>;
  title: string | null;
  year: number | null;
  /** `DB` タグの値（あれば）。例: `PubMed` / `Embase` / `CENTRAL` / `Scopus` */
  originalDb: string | null;
  /** DOI（`DO` タグ）。存在しなければ null */
  doi: string | null;
}

const TAG_LINE_PATTERN = /^([A-Z][A-Z0-9])\s{1,}-\s?(.*)$/;

export function parseRis(text: string): RisEntry[] {
  const entries: RisEntry[] = [];
  let current: Record<string, string[]> | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\ufeff/, ''); // BOM 除去
    if (line.trim() === '') {
      continue;
    }
    const match = line.match(TAG_LINE_PATTERN);
    if (!match) {
      continue;
    }
    // TAG_LINE_PATTERN が 2 つのキャプチャを保証する
    const tag = match[1] as string;
    const value = match[2] as string;
    if (tag === 'ER') {
      if (current !== null) {
        entries.push(finalizeEntry(current));
        current = null;
      }
      continue;
    }
    if (tag === 'TY') {
      // 新しいレコードの開始
      if (current !== null) {
        entries.push(finalizeEntry(current));
      }
      current = {};
    }
    if (current === null) {
      current = {};
    }
    if (!current[tag]) {
      current[tag] = [];
    }
    current[tag].push(value.trim());
  }
  if (current !== null) {
    entries.push(finalizeEntry(current));
  }
  return entries;
}

function finalizeEntry(tags: Record<string, string[]>): RisEntry {
  return {
    tags,
    title: firstValue(tags, 'TI') ?? firstValue(tags, 'T1') ?? null,
    year: parseYear(firstValue(tags, 'PY') ?? firstValue(tags, 'Y1')),
    originalDb: firstValue(tags, 'DB') ?? null,
    doi: firstValue(tags, 'DO') ?? null,
  };
}

function firstValue(tags: Record<string, string[]>, key: string): string | undefined {
  return tags[key]?.[0];
}

function parseYear(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/\d{4}/);
  return match ? Number.parseInt(match[0], 10) : null;
}
