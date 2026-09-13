import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProtocolDraft, BlocksDraft } from '../../src/app/store';
import type { SeedContext } from '../../src/app/services/draftService';
import type { PubmedFormula } from '../../src/lib/search-formula-md';

/** criteria-only は適格基準のみ、seeded は凍結シードのタイトル/抄録/MeSH も渡す。 */
export type C0Variant = 'criteria-only' | 'seeded';

/** freezeC0 が書き出す固定 C0 の内容（sha256 を除く）。ハッシュはこの形をそのまま対象にする。 */
export interface C0Content {
  schemaVersion: 1;
  /** 取り込み時だけ付与する由来。既存ファイルには補完せず、従来のハッシュを維持する。 */
  source?: 'import';
  sourceFilename?: string;
  caseId: string;
  variant: C0Variant;
  draftIndex: number;
  /** seeded のときだけ split id（例: `s20260912`）。criteria-only は null。 */
  seedSplit: string | null;
  targetHits: number;
  model: string;
  createdAt: string;
  gitCommit: string | null;
  gitDirty: boolean | null;
  protocol: ProtocolDraft;
  blocks: BlocksDraft;
  formula: PubmedFormula;
  formulaMd: string;
  seedContext: SeedContext | null;
  blockApproval: 'auto';
}

export interface C0Artifact extends C0Content {
  sha256: string;
}

/** キー順序に依存しないハッシュにするため、オブジェクトキーを再帰的にソートする。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

/** 内容（sha256 を除く）から改ざん検出用ハッシュを計算する。 */
export function hashC0Content(content: C0Content): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
}

/** 出力ファイル名（拡張子なし）。既定 split では split 接尾辞を付けない。 */
export function c0FileName(variant: C0Variant, draftIndex: number, seedSplitSuffix: string | null): string {
  return `${variant}-draft${draftIndex}${seedSplitSuffix ? `-${seedSplitSuffix}` : ''}`;
}

export function c0Dir(fixturesDir: string, caseId: string): string {
  return join(fixturesDir, caseId, 'c0');
}

export function c0FixturePath(fixturesDir: string, caseId: string, name: string): string {
  return join(c0Dir(fixturesDir, caseId), `${name}.json`);
}

/**
 * run.ts / compare.ts が凍結 C0 を読むときの検証つきロード。
 * ケース ID の不一致・ハッシュ不一致（改ざん・破損・生成コードとの不整合）を拒否する。
 */
export function loadC0Artifact(fixturesDir: string, caseId: string, name: string): C0Artifact {
  const path = c0FixturePath(fixturesDir, caseId, name);
  if (!existsSync(path)) {
    throw new Error(`凍結 C0 が見つかりません: ${path}`);
  }
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as C0Artifact;
  if (artifact.caseId !== caseId) {
    throw new Error(`凍結 C0 のケース ID が一致しません（${name}）: 期待=${caseId}, 実際=${artifact.caseId}`);
  }
  const { sha256, ...content } = artifact;
  if (hashC0Content(content) !== sha256) {
    throw new Error(`凍結 C0 のハッシュが一致しません（改ざんまたは破損の可能性）: ${name}`);
  }
  return artifact;
}
