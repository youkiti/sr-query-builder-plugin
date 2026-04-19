import type { ConversionEntry, TargetDatabase } from '@/domain/conversion';
import {
  appendConversion,
  convertToAllDatabases,
  type ConversionResult,
} from '@/features/conversion';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import type { GoogleApiDeps } from '@/lib/google';
import { nowIso } from '@/utils/iso8601';
import { newUuid } from '@/utils/uuid';
import type { AppStore } from '../store';

/**
 * 確定済みの PubMed 検索式を 4 DB（CENTRAL / Dialog / CT.gov / ICTRP）へ
 * 変換し、Conversions タブに保存する。
 *
 * - store.currentFormulaMarkdown を入力として parsePubmedFormulaMd でパース
 * - 各 converter は features/conversion で既に実装済み
 * - 結果は ExportResult で返し、UI 側がダウンロードボタン等に使う
 */

export interface ExportServiceDeps {
  google: GoogleApiDeps;
  store: AppStore;
  /** テスト時に差し替え可能な UUID / 時刻 */
  newUuid?: () => string;
  now?: () => string;
}

export interface ExportResult {
  /** 各 DB の変換結果（convertedFormula / warnings を含む） */
  conversions: ConversionResult[];
  /** Conversions タブに書き込んだ行（conversion_id 付き） */
  entries: ConversionEntry[];
}

/**
 * 現在選択中の FormulaVersion を 4 DB に変換し、Conversions タブに保存する。
 */
export async function exportToAllDatabases(deps: ExportServiceDeps): Promise<ExportResult> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  if (!state.currentFormulaVersionId || !state.currentFormulaMarkdown) {
    throw new Error('検索式ドラフトが未生成です。先に /draft で生成してください');
  }
  const formula = parsePubmedFormulaMd(state.currentFormulaMarkdown);
  const conversions = convertToAllDatabases(formula);
  const uuidFn = deps.newUuid ?? newUuid;
  const nowFn = deps.now ?? nowIso;
  const entries: ConversionEntry[] = [];
  for (const conversion of conversions) {
    const entry: ConversionEntry = {
      conversionId: uuidFn(),
      versionId: state.currentFormulaVersionId,
      targetDb: conversion.targetDb,
      convertedFormula: conversion.convertedFormula,
      warnings:
        conversion.warnings.length === 0
          ? null
          : conversion.warnings.join('\n'),
      exportedAt: nowFn(),
    };
    await appendConversion(state.project.spreadsheetId, entry, deps.google);
    entries.push(entry);
  }
  return { conversions, entries };
}

/**
 * 変換結果 1 件をダウンロード用 `data:` URL に変換する。
 * ブラウザで `<a download>` にこの URL をセットすればファイル保存できる。
 */
export function toDownloadUrl(result: ConversionResult): string {
  const encoded = encodeURIComponent(result.convertedFormula);
  return `data:text/markdown;charset=utf-8,${encoded}`;
}

export function suggestFileName(targetDb: TargetDatabase): string {
  return `search-formula.${targetDb}.md`;
}
