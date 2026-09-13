import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from './c0Artifact';
import { parseSkillJson } from '../../src/features/formula/skills/parseSkillJson';
import type { LLMProvider } from '../../src/lib/llm/LLMProvider';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';

/**
 * issue #128 の手順 4「固定提案による replay」。`optimize_query` の LLM 応答だけを
 * fixture から固定して流し、製品の `runQueryOptimization` と実 NCBI の計測・採否判定は
 * そのまま通す。自由生成の性能評価（run.ts の通常経路）とは別に記録する。
 */

/** fixture ファイル名・`--replay` に渡す名前の形式。C0 の名前付き集合と同じ規則。 */
const REPLAY_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export interface ReplayFixtureContent {
  name: string;
  caseId: string;
  /** 適用先の凍結 C0。実行時の --c0 と名前・ハッシュが一致しなければ拒否する。 */
  c0: { name: string; sha256: string };
  /** 出所の記録（監査用。読み込み時の検証はしない）。 */
  source: { runId: string; logs: { file: string; sha256: string }[]; description: string };
  /** `optimize_query` の応答テキスト（`response.text` そのまま）。先頭から順に 1 回 1 件返す。 */
  responses: string[];
}

export function replayFixturePath(fixturesDir: string, caseId: string, name: string): string {
  return join(fixturesDir, caseId, 'replay', `${name}.json`);
}

/** 個々の応答が製品の `optimizeQuery` スキルと同じ前提（JSON・対象ブロック ID・変更後の式）を満たすか検証する。 */
function validateResponseText(text: string, index: number, fixtureName: string): void {
  let parsed: { target_block_id?: unknown; proposed_expression?: unknown };
  try {
    parsed = parseSkillJson(text, `replay:${fixtureName}[${index}]`);
  } catch (err) {
    throw new Error(`replay ${fixtureName} の応答 ${index} が JSON としてパースできません: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed.target_block_id !== 'string' || parsed.target_block_id.trim() === ''
    || typeof parsed.proposed_expression !== 'string' || parsed.proposed_expression.trim() === '') {
    throw new Error(`replay ${fixtureName} の応答 ${index} に target_block_id / proposed_expression がありません`);
  }
}

/**
 * `fixtures/<caseId>/replay/<name>.json` を読み、名前・ケース ID・応答の形式を検証する。
 * C0 との照合（名前・ハッシュ）は呼び出し側（run.ts）が --c0 で読み込んだ凍結 C0 と突き合わせて行う。
 */
export function loadReplayFixture(fixturesDir: string, caseId: string, name: string): ReplayFixtureContent {
  if (!REPLAY_NAME_PATTERN.test(name)) {
    throw new Error('--replay には英小文字で始まる英小文字・数字・ハイフンの 1〜32 文字を指定してください');
  }
  const path = replayFixturePath(fixturesDir, caseId, name);
  if (!existsSync(path)) throw new Error(`replay fixture が見つかりません: ${path}`);
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as ReplayFixtureContent;
  if (fixture.name !== name) throw new Error(`replay fixture の name（${fixture.name}）がファイル名（${name}）と一致しません`);
  if (fixture.caseId !== caseId) throw new Error(`replay fixture のケース ID が一致しません（${name}）: 期待=${caseId}, 実際=${fixture.caseId}`);
  if (!fixture.c0 || typeof fixture.c0.name !== 'string' || !fixture.c0.name || typeof fixture.c0.sha256 !== 'string' || !fixture.c0.sha256) {
    throw new Error(`replay fixture ${name} の c0（適用先の凍結 C0）が不正です`);
  }
  if (!Array.isArray(fixture.responses) || fixture.responses.length === 0) {
    throw new Error(`replay fixture ${name} には responses が 1 件以上必要です`);
  }
  fixture.responses.forEach((text, index) => validateResponseText(text, index, name));
  return fixture;
}

/** 適用した fixture 内容から改ざん検出・run 間比較用のハッシュを計算する。c0Artifact.ts と同じやり方。 */
export function hashReplayFixture(content: ReplayFixtureContent): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
}

export interface ReplayLlmFactory extends LlmProviderFactory {
  /** `forPurpose('optimize_query')` の呼び出し回数（chat の実行回数ではない）。 */
  calls: () => number;
  /** 実際に応答を返せた回数。 */
  used: () => number;
  /** 用意した応答をすべて使い切ったか。 */
  exhausted: () => boolean;
  /**
   * `runQueryOptimization` の `deps.shouldStop` にそのまま渡す。
   * 「`forPurpose('optimize_query')` の呼び出し回数 > 応答数」になった時点で true を返し、
   * 直後の境界（`optimizeQuery` が実際に `chat` を呼ぶ直前）で安全に停止させる。
   * 最後の応答の候補は評価し終えてから止まる（安全弁は末尾の catch を参照）。
   */
  shouldStop: () => boolean;
}

/**
 * `optimize_query` だけを fixture の固定応答へ差し替えた合成 LLM ファクトリを作る。
 * 他の purpose（confirmation の `expand_recall` / `pick_boundary` 等）は `realFactory` へそのまま委譲する。
 *
 * 応答の記録先（監査ログ）は呼び出し側の `buildLoggedFactory` に委ねる。usage tracker への計上は
 * 呼び出し側が `buildLoggedFactory` に `onUsage` を渡さないことで避ける（実 fetch もしないため
 * `apiCalls.llm` にも入らない）。
 */
export function createReplayLlmFactory(
  name: string,
  responses: readonly string[],
  realFactory: LlmProviderFactory,
  buildLoggedFactory: (provider: LLMProvider) => LlmProviderFactory,
): ReplayLlmFactory {
  let used = 0;
  const rawProvider: LLMProvider = {
    providerId: 'gemini',
    model: `replay:${name}`,
    chat: async () => {
      // shouldStop が forPurpose の呼び出し直後・chat 呼び出し直前で止めるため、通常はここに来ない。
      if (used >= responses.length) {
        throw new Error(`replay ${name}: 用意した応答（${responses.length} 件）を使い切った後に chat が呼ばれました`);
      }
      const text = responses[used]!;
      used += 1;
      return { text, tokensIn: null, tokensOut: null, raw: { replay: name, index: used - 1 } };
    },
  };
  const replayLogged = buildLoggedFactory(rawProvider);
  let calls = 0;
  return {
    model: realFactory.model,
    forPurpose: (purpose, onRequestState) => {
      if (purpose !== 'optimize_query') return realFactory.forPurpose(purpose, onRequestState);
      calls += 1;
      return replayLogged.forPurpose(purpose, onRequestState);
    },
    calls: () => calls,
    used: () => used,
    exhausted: () => used >= responses.length,
    shouldStop: () => calls > responses.length,
  };
}
