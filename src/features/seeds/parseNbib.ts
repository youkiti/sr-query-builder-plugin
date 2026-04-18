/**
 * PubMed NBIB（MEDLINE）形式のテキストをパースする。
 *
 * NBIB レコード例（抜粋）:
 * ```
 * PMID- 12345678
 * TI  - Title of the paper
 *       continuation line
 * DP  - 2020 Jan
 * ```
 * - タグは 4 文字 + `- `（左寄せ、スペースでパディング）
 * - 同タグの継続は先頭スペースインデント行
 * - レコード境界は空行
 */

export interface NbibEntry {
  pmid: string | null;
  title: string | null;
  year: number | null;
  /** パーサが認識した生タグ全体。キーはトリム済み（例: `"PMID"`, `"TI"`） */
  tags: Record<string, string[]>;
}

const TAG_LINE_PATTERN = /^([A-Z][A-Z0-9]{1,3})\s*-\s?(.*)$/;
const CONTINUATION_PATTERN = /^\s+(.+)$/;

export function parseNbib(text: string): NbibEntry[] {
  const records = splitRecords(text);
  return records.map(parseSingleRecord).filter((entry): entry is NbibEntry => entry !== null);
}

function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  let current: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '') {
      if (current.length > 0) {
        records.push(current);
        current = [];
      }
      continue;
    }
    current.push(rawLine);
  }
  if (current.length > 0) {
    records.push(current);
  }
  return records;
}

function parseSingleRecord(lines: string[]): NbibEntry | null {
  const tags: Record<string, string[]> = {};
  let lastTag: string | null = null;
  for (const line of lines) {
    const tagMatch = line.match(TAG_LINE_PATTERN);
    if (tagMatch) {
      // TAG_LINE_PATTERN が 2 つのキャプチャを保証する
      const tag = tagMatch[1] as string;
      const value = tagMatch[2] as string;
      if (!tags[tag]) {
        tags[tag] = [];
      }
      tags[tag].push(value.trim());
      lastTag = tag;
      continue;
    }
    const contMatch = line.match(CONTINUATION_PATTERN);
    if (contMatch && lastTag !== null) {
      const values = tags[lastTag];
      /* istanbul ignore next -- lastTag が立つときは必ず values も存在する */
      if (!values || values.length === 0) {
        continue;
      }
      const lastIdx = values.length - 1;
      const contValue = contMatch[1] as string;
      values[lastIdx] = `${values[lastIdx]} ${contValue.trim()}`;
    }
  }
  if (Object.keys(tags).length === 0) {
    return null;
  }
  const pmid = firstValue(tags, 'PMID');
  return {
    pmid: pmid ?? null,
    title: firstValue(tags, 'TI') ?? null,
    year: parseYearFromTags(tags),
    tags,
  };
}

function firstValue(tags: Record<string, string[]>, key: string): string | undefined {
  return tags[key]?.[0];
}

function parseYearFromTags(tags: Record<string, string[]>): number | null {
  const candidates = [firstValue(tags, 'DP'), firstValue(tags, 'PDAT')];
  for (const value of candidates) {
    if (!value) continue;
    const match = value.match(/\d{4}/);
    if (match) {
      return Number.parseInt(match[0], 10);
    }
  }
  return null;
}
