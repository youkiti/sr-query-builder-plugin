import type { OptimizationApiEvent, OptimizationMeasurement, OptimizationMeshNode, OptimizationTrial } from '@/features/formula/skills/optimizeQuery';
import { extractBlockTerms } from '@/features/validation/blockTerms';
import { buildPubmedSearchUrl } from '@/lib/ncbi/pubmedUrl';
import type { OptimizationResumeAvailability } from '../services/queryOptimizationCheckpointService';
import { tokenizeExpression } from '@/lib/search-formula-md/expression';
import type { QueryOptimizationRunState, QueryOptimizationSetupState } from '../store';

const hits = (value: number | null | undefined): string => value == null ? '未測定' : `${value.toLocaleString()} 件`;

export function optimizationApiLabel(event: OptimizationApiEvent): string {
  return `${event.source}: ${{ rate_limit: 'レート調整中', retry: '再試行中', failure: '取得失敗' }[event.status]}`;
}

function paragraph(parent: HTMLElement, value: string): void {
  const p = parent.ownerDocument.createElement('p');
  p.textContent = value;
  parent.appendChild(p);
}

function seedCount(measurement: OptimizationMeasurement | null, total: number | null): string {
  return measurement?.capturedPmids == null ? '未測定' : `${measurement.capturedPmids.length}/${total ?? '不明'}件`;
}

function changedTerms(trial: OptimizationTrial): { label: string; before?: string; after?: string }[] {
  const changes = trial.kind === 'proposal' ? trial.changes : undefined;
  return changes ? [
    ...changes.removedTerms.map((before) => ({ label: '削除', before })),
    ...changes.addedTerms.map((after) => ({ label: '追加', after })),
    ...changes.replacedTerms.map((term) => ({ label: '修正', ...term })),
  ] : [];
}

function matchingQuery<T extends { query: string }>(terms: T[], query: string | undefined): T | undefined {
  if (!query) return undefined;
  const exact = terms.find((term) => term.query.trim().toLowerCase() === query.trim().toLowerCase());
  if (exact || query.includes('[')) return exact;
  const bare = (value: string) => value.replace(/\[[^\]]*\]\s*$/, '').trim().replace(/^"|"$/g, '').toLowerCase();
  const matches = terms.filter((term) => bare(term.query) === bare(query));
  // AI がタグを省略した場合も、実測語を一意に特定できるときだけ対応づける。
  return matches.length === 1 ? matches[0] : undefined;
}

function measuredTerm(trial: OptimizationTrial, query: string | undefined, side: 'before' | 'after') {
  return matchingQuery(trial[side]?.terms?.filter((item) => item.blockId === trial.changes?.targetBlockId) ?? [], query);
}

function resolvedQuery(trial: OptimizationTrial, query: string | undefined, side: 'before' | 'after'): string {
  const measured = measuredTerm(trial, query, side);
  if (measured) return measured.query;
  const expression = side === 'after' ? trial.formula.blocks.find((block) => block.id === trial.changes?.targetBlockId)?.expression : '';
  return matchingQuery(tokenizeExpression(expression ?? '').filter((segment) => segment.kind !== 'plain')
    .map((segment) => ({ query: segment.text })), query)?.query ?? query ?? '';
}

function termHits(trial: OptimizationTrial, query: string | undefined, side: 'before' | 'after'): string {
  return hits(measuredTerm(trial, query, side)?.hits);
}

function contribution(trial: OptimizationTrial, query: string | undefined, side: 'before' | 'after'): string {
  return hits(measuredTerm(trial, query, side)?.finalContribution);
}

function meshTermsForChange(trial: OptimizationTrial, change: ReturnType<typeof changedTerms>[number]) {
  return extractBlockTerms(`${resolvedQuery(trial, change.before, 'before')} ${resolvedQuery(trial, change.after, 'after')}`).meshTerms;
}

function relatedMeshNodes(trial: OptimizationTrial, context: OptimizationMeshNode[]): OptimizationMeshNode[] {
  const references = trial.kind === 'information' ? trial.meshRequests ?? []
    : changedTerms(trial).flatMap((change) => meshTermsForChange(trial, change)
      .map((term) => ({ descriptor: term.descriptor, treeNumber: '' })));
  const normalized = (value: string) => value.trim().toLowerCase();
  const targets = context.filter((node) => references.some((ref) =>
    (ref.descriptor && [node.id, node.descriptor, node.label ?? ''].some((value) => normalized(value) === normalized(ref.descriptor)))
    || (ref.treeNumber && node.treeNumbers.includes(ref.treeNumber))));
  // 変更語・要求した枝と、取得済みの直近の親子だけを表示する。
  return context.filter((node) => targets.some((target) => node.id === target.id
    || target.parentIds.includes(node.id) || target.childIds.includes(node.id)
    || node.parentIds.includes(target.id) || node.childIds.includes(target.id)));
}

function renderMeshDetails(mesh: HTMLElement, trial: OptimizationTrial, nodes: OptimizationMeshNode[]): void {
  const heading = mesh.ownerDocument.createElement('h4');
  heading.textContent = 'MeSH';
  mesh.replaceChildren(heading);
  const meshChanges = changedTerms(trial).filter((change) => meshTermsForChange(trial, change).length > 0);
  if (!meshChanges.length) paragraph(mesh, trial.kind === 'information' ? '周辺ツリーの情報要求。式は変更していません。' : 'MeSH の変更記録なし');
  for (const change of meshChanges) {
    paragraph(mesh, `${change.label}: ${change.before ?? 'なし'} → ${change.after ?? 'なし'}`);
    paragraph(mesh, `単独件数（変更前 → 変更後）: ${termHits(trial, change.before, 'before')} → ${termHits(trial, change.after, 'after')}`);
  }
  if (meshChanges.length || trial.kind === 'information') {
    const edges = new Set<string>();
    for (const parent of nodes) {
      for (const child of nodes.filter((node) => parent.childIds.includes(node.id) || node.parentIds.includes(parent.id))) {
        edges.add(`${parent.label ?? parent.descriptor} → ${child.label ?? child.descriptor}`);
      }
    }
    paragraph(mesh, edges.size ? `取得済みの上位語 → 下位語: ${[...edges].join(' / ')}` : '親子関係は未取得です。置換方向は未確認です。');
    for (const node of nodes) {
      paragraph(mesh, `${node.label ?? node.descriptor}: ${node.treeNumbers.join(', ') || 'ツリー番号未取得'} / explode: ${node.explode ? 'あり' : 'なし'} / ${node.note}`);
    }
    paragraph(mesh, `根拠（AI の説明）: ${trial.rationale || '記録なし'}`);
    paragraph(mesh, `最終式の前後件数: ${hits(trial.before?.totalHits)} → ${hits(trial.after?.totalHits)}`);
  }
}

function renderDetails(details: HTMLElement, trial: OptimizationTrial, nodes: OptimizationMeshNode[]): void {
  const doc = details.ownerDocument;
  const freewordChanges = changedTerms(trial).filter((change) => meshTermsForChange(trial, change).length === 0);
  const group = (label: string): HTMLElement => {
    const section = doc.createElement('section');
    const heading = doc.createElement('h4');
    heading.textContent = label;
    section.appendChild(heading);
    details.appendChild(section);
    return section;
  };
  renderMeshDetails(group('MeSH'), trial, nodes);

  const freewords = group('フリーワード');
  if (!freewordChanges.length) paragraph(freewords, 'フリーワードの変更記録なし');
  for (const change of freewordChanges) {
    paragraph(freewords, `${change.label}: ${change.before ?? 'なし'} → ${change.after ?? 'なし'}`);
    paragraph(freewords, `単独件数（変更前 → 変更後）: ${termHits(trial, change.before, 'before')} → ${termHits(trial, change.after, 'after')}`);
    paragraph(freewords, `最終式での固有寄与（変更前 → 変更後）: ${contribution(trial, change.before, 'before')} → ${contribution(trial, change.after, 'after')}`);
  }
  if (freewordChanges.length) paragraph(freewords, `基準との関係（AI の説明）: ${trial.rationale || '記録なし'}`);

  const seeds = group('シード');
  const before = trial.before?.capturedPmids;
  const after = trial.after?.capturedPmids;
  if (after == null || (trial.before && before == null)) {
    paragraph(seeds, '未測定のため、回収・喪失は未確認です。');
  } else {
    const recovered = after.filter((pmid) => !before?.includes(pmid));
    const lost = (before ?? []).filter((pmid) => !after.includes(pmid));
    for (const [label, pmids] of [
      [trial.accepted ? '回収' : '却下候補での回収（最良候補には未反映）', recovered],
      [trial.accepted ? '喪失' : '失ったため戻したシード', lost],
    ] as const) {
      if (!pmids.length) continue;
      const p = doc.createElement('p');
      p.append(`${label}: `);
      for (const pmid of pmids) {
        const link = doc.createElement('a');
        link.textContent = `PMID ${pmid}`;
        link.href = buildPubmedSearchUrl(`${pmid}[uid]`);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        p.append(link, ' ');
      }
      seeds.appendChild(p);
    }
    if (!recovered.length && !lost.length) paragraph(seeds, '捕捉シードの変化なし');
  }
  const captureGroup = group('シード × ブロック捕捉表');
  const capture = trial.after?.seedCapture;
  if (!capture) paragraph(captureGroup, '捕捉表は未計測（未捕捉シードがある局面でだけ測ります）');
  else {
    const wrapper = doc.createElement('div');
    wrapper.className = 'optimization__capture-table';
    const table = doc.createElement('table');
    table.setAttribute('aria-label', 'シード × ブロック捕捉表');
    const head = table.createTHead().insertRow();
    for (const label of ['シード PMID', ...capture.rows.map((row) => `#${row.blockId}`)]) {
      const th = doc.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      head.appendChild(th);
    }
    const body = table.createTBody();
    for (const pmid of capture.seedPmids) {
      const row = body.insertRow();
      const th = doc.createElement('th');
      th.scope = 'row';
      th.textContent = pmid;
      row.appendChild(th);
      for (const block of capture.rows) {
        row.insertCell().textContent = block.capturedPmids === null ? '未測定' : block.capturedPmids.includes(pmid) ? '○' : '×';
      }
    }
    wrapper.appendChild(table);
    captureGroup.appendChild(wrapper);
  }
  const deletion = group('削除影響');
  const impact = trial.impact;
  if (!impact) paragraph(deletion, '採用判定の前に却下したため、差集合は実測していません');
  else {
    paragraph(deletion, `失う集合: ${impact.lostHits ?? '未測定'} 件 / 増える集合: ${impact.gainedHits ?? '未測定'} 件`);
    paragraph(deletion, impact.sample
      ? `抽出方法: ${impact.sample.method === 'all' ? 'all（全件から無作為抽出）' : `retrieved_subset（取得できた ${impact.sample.retrievedCount} 件から無作為抽出。集合全体からの無作為抽出ではありません）`} / 種: ${impact.sample.seed}`
      : '抽出方法: 旧データ（先頭の数件） / 種: 記録なし');
    paragraph(deletion, `確認した書誌: ${impact.inspected.length} 件 / 失う集合全体 ${impact.lostHits ?? '未測定'} 件（${impact.sample ? '抽出した書誌であり' : '先頭の数件であり'}、集合全体の安全性を示すものではありません）`);
    for (const article of impact.inspected) {
      const p = doc.createElement('p');
      const link = doc.createElement('a');
      link.textContent = `PMID ${article.pmid}（${article.year ?? '年不明'}）${article.title ?? 'タイトル未取得'}`;
      link.href = buildPubmedSearchUrl(`${article.pmid}[uid]`);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      p.appendChild(link);
      deletion.appendChild(p);
    }
    if (impact.error) paragraph(deletion, `実測・取得の失敗: ${impact.error}`);
  }
  const api = group('API 待機');
  if (!trial.apiEvents.length) paragraph(api, '通知された待機・取得失敗の記録なし');
  for (const event of trial.apiEvents) paragraph(api, `${optimizationApiLabel(event)}（この試行中の記録）`);
}

/** データは毎回 state から読む。スクロール位置と開閉状態だけを DOM に保持する。 */
export function createOptimizationHistoryRenderer(): (
  container: HTMLElement, run: QueryOptimizationRunState | null, setup: QueryOptimizationSetupState | null,
  resume?: { availability: OptimizationResumeAvailability;
    start?: () => void; disabled: boolean }
) => void {
  let key = '';
  let section: HTMLElement | null = null;
  let viewport: HTMLElement | null = null;
  let list: HTMLOListElement | null = null;
  let follow = true;
  let scrollTop = 0;
  let renderedContext: OptimizationMeshNode[] | null = null;
  const rows = new Map<string, { element: HTMLLIElement; trial: OptimizationTrial }>();
  return (container, run, setup, resume) => {
    const doc = container.ownerDocument;
    container.querySelector('.optimization__restored')?.remove();
    if (run) {
      const nextKey = `${run.projectId}:${run.runId}`;
      if (key !== nextKey || !section || !viewport || !list) {
        key = nextKey;
        rows.clear();
        follow = true;
        scrollTop = 0;
        section = doc.createElement('section');
        section.className = 'optimization__history';
        section.dataset.optimizationRun = nextKey;
        const heading = doc.createElement('h3');
        heading.textContent = '試行履歴';
        section.appendChild(heading);
        viewport = doc.createElement('div');
        viewport.className = 'optimization__history-scroll';
        viewport.tabIndex = 0;
        viewport.setAttribute('role', 'region');
        viewport.setAttribute('aria-label', '自動調整の試行履歴');
        viewport.addEventListener('scroll', () => {
          if (!viewport?.isConnected) return;
          scrollTop = viewport.scrollTop;
          follow = viewport.scrollHeight - viewport.clientHeight - scrollTop <= 8;
        });
        list = doc.createElement('ol');
        viewport.appendChild(list);
        section.appendChild(viewport);
      }
      let evaluated = 0;
      let added = false;
      const contextChanged = renderedContext !== run.meshContext;
      for (const trial of run.trials) {
        const label = trial.kind === 'initial' ? '初期式' : trial.kind === 'final' ? '最終再検証'
          : trial.kind === 'information' ? '情報要求' : `試行${++evaluated}`;
        const nodes = relatedMeshNodes(trial, run.meshContext);
        const existing = rows.get(trial.candidateId);
        if (existing && (existing.trial === trial || JSON.stringify(existing.trial) === JSON.stringify(trial))) {
          if (contextChanged) {
            renderMeshDetails(existing.element.querySelector<HTMLElement>('details > section')!, trial, nodes);
          }
          existing.trial = trial;
          continue;
        }
        const row = doc.createElement('li');
        paragraph(row, `${label} — 前後件数: ${hits(trial.before?.totalHits)} → ${hits(trial.after?.totalHits)} / シード: ${seedCount(trial.before, run.seedCount)} → ${seedCount(trial.after, run.seedCount)} / ${trial.kind === 'information' ? '評価保留' : trial.held ? '保留' : trial.accepted ? '採用' : '却下'}: ${trial.reason}`);
        if (trial.kind === 'information' && trial.informationResult) {
          paragraph(row, `情報要求 ${trial.candidateId}: 文脈へ反映 ${trial.informationResult.obtained} / 要求 ${trial.informationResult.requested} 件`);
        }
        if (trial.informedBy) {
          paragraph(row, `情報要求 ${trial.informedBy.candidateId} で得た文脈 ${trial.informedBy.obtained}/${trial.informedBy.requested} 件を読んだうえでの判断`);
        }
        if (trial.rationale) paragraph(row, `変更理由（AI の説明）: ${trial.rationale}`);
        const details = doc.createElement('details');
        details.open = existing?.element.querySelector('details')?.open ?? false;
        const summary = doc.createElement('summary');
        summary.textContent = `${label}の変更詳細`;
        details.appendChild(summary);
        renderDetails(details, trial, nodes);
        row.appendChild(details);
        if (existing) existing.element.replaceWith(row);
        else { list.appendChild(row); added = true; }
        rows.set(trial.candidateId, { element: row, trial });
      }
      renderedContext = run.meshContext;
      if (section.parentElement !== container) container.insertBefore(section, container.children.item(2));
      // 画面全体ではなく履歴領域だけを動かす。新規行がない更新では追従しない。
      viewport.scrollTop = follow && added ? viewport.scrollHeight : scrollTop;
      scrollTop = viewport.scrollTop;
    }
    if (setup?.checkpoint && (!run || run.trials.length === 0)) {
      const checkpoint = setup.checkpoint;
      const restored = doc.createElement('section');
      restored.className = 'optimization__restored';
      const title = doc.createElement('h3');
      title.textContent = checkpoint.status === 'interrupted' ? '中断された自動調整の履歴' : '完了済みの自動調整の履歴';
      restored.appendChild(title);
      paragraph(restored, checkpoint.status === 'interrupted' ? '処理は中断しています。バックグラウンドでは継続していません。' : 'この実行は終了しています。');
      paragraph(restored, `保存日時: ${checkpoint.savedAt}。ログのみを復元しました。以下は保存時の記録で、再検証は済んでいません。`);
      if (!run && checkpoint.status === 'interrupted' && resume) {
        const message = doc.createElement('p');
        message.setAttribute('aria-live', 'polite');
        if (resume.availability.available) {
          const remaining = resume.availability.remaining;
          message.textContent = `保存した最良候補を初期式にして新しい実行を開始し、件数・シード捕捉をすべて測り直します。残り予算: 通信 ${remaining.apiCalls} 回 / 時間 ${Math.floor(remaining.elapsedMs / 1000)} 秒 / 評価試行 ${remaining.evaluatedTrials} 回。`;
          restored.appendChild(message);
          const button = doc.createElement('button');
          button.type = 'button';
          button.className = 'optimization__resume';
          button.textContent = '最良候補から再開して測り直す';
          button.disabled = resume.disabled || !resume.start;
          button.addEventListener('click', () => {
            if (button.disabled) return;
            button.disabled = true;
            resume.start?.();
          });
          restored.appendChild(button);
        } else {
          message.textContent = resume.availability.reason;
          restored.appendChild(message);
        }
      }
      const summaries = doc.createElement('ul');
      for (const trial of checkpoint.trials) {
        const item = doc.createElement('li');
        item.textContent = `${trial.candidateId}: ${hits(trial.totalHits)} / シード捕捉 ${trial.capturedSeedCount == null ? '未測定' : `${trial.capturedSeedCount}件（総数の記録なし）`} / ${trial.held ? '保留' : trial.accepted ? '採用' : '却下'}: ${trial.reason}${trial.lostHits !== undefined ? ` / 失う ${trial.lostHits ?? '未測定'} 件` : ''}`;
        summaries.appendChild(item);
      }
      restored.appendChild(summaries);
      container.appendChild(restored);
    }
  };
}
