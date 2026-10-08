import {
  GUIDE_PROGRESS_STORAGE_KEY,
  createEmptyGuideProgress,
  parseGuideProgress,
  serializeGuideProgress,
  type GuideProgress,
} from './tourProgress';

async function getLocal(key: string): Promise<unknown> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return undefined;
  return (await chrome.storage.local.get(key))[key];
}
async function setLocal(key: string, value: unknown): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  await chrome.storage.local.set({ [key]: value });
}

let progress: GuideProgress = createEmptyGuideProgress();
let loading: Promise<void> | null = null;
/** 「あとで」はこのセッション内だけで保持する。 */
let postponed = false;

/** 初回だけ保存値を読み、以降は最新の保持値を返す。読み込み失敗でも画面を止めない。 */
export async function loadGuideProgress(): Promise<GuideProgress> {
  if (!loading) {
    loading = getLocal(GUIDE_PROGRESS_STORAGE_KEY)
      .then(stored => { progress = parseGuideProgress(stored); })
      .catch(error => { console.warn('[guide] 進行状態の読み込みに失敗:', error); });
  }
  await loading;
  return progress;
}

/** loadGuideProgress の完了後に利用する保持値。 */
export function getGuideProgress(): GuideProgress {
  return progress;
}

/** 保持値を更新して保存する。保存に失敗しても保持値は戻さない。 */
export function updateGuideProgress(update: (current: GuideProgress) => GuideProgress): void {
  progress = update(progress);
  void setLocal(GUIDE_PROGRESS_STORAGE_KEY, serializeGuideProgress(progress))
    .catch(error => { console.warn('[guide] 進行状態の保存に失敗:', error); });
}

/** 保存の変更を保持値へ反映して通知する。追従では保存せず、通知の往復を防ぐ。 */
export function subscribeGuideProgressChange(listener: () => void): () => void {
  const source = typeof chrome === 'undefined' ? undefined : chrome.storage?.onChanged;
  if (!source) return () => {};
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
    if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, GUIDE_PROGRESS_STORAGE_KEY)) return;
    progress = parseGuideProgress(changes[GUIDE_PROGRESS_STORAGE_KEY]!.newValue);
    listener();
  };
  source.addListener(onChanged);
  return () => { source.removeListener(onChanged); };
}

export function isGuidePostponed(): boolean {
  return postponed;
}

export function postponeGuideSuggestions(): void {
  postponed = true;
}
