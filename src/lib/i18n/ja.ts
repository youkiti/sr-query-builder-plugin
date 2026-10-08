// UI 文言辞書（日本語。キー集合の正典）。
// 現在はツアー関連（guide.*）の文言だけを持つ。アプリ本体の既存の文言はここへ移していない。
// en.ts は Record<MessageKey, string> で全キーの網羅を型強制する。
export const ja = {
  // ツアー共通
  'guide.openTours': 'ツアー',
  'guide.suggest': '操作ツアーで、画面の流れを確かめましょう。',
  'guide.startSuggested': 'ツアーで進める',
  'guide.postpone': 'あとで',
  'guide.suppress': '今後表示しない',
  'guide.closeList': '一覧を閉じる',
  'guide.done': '済み',
  'guide.start': '始める',
  'guide.waiting': '対象が表示されるのを待っています。',
  'guide.goRoute': 'この画面へ移動',
  'guide.skip': '押さずに次へ',
  'guide.complete': '完了',
  'guide.next': '次へ',
  'guide.end': 'ツアーを終える',
  'guide.language': '表示言語',
  'guide.languageJa': '日本語',
  'guide.languageEn': 'English',
  // 「?」メニュー（見出しの横のヘルプ・動画・ツアーの入口）
  'guide.helpFor': '{title} のヘルプ',
  'guide.menuReadHelp': 'ヘルプを読む',
  'guide.menuWatchVideo': 'この機能の動画を見る',
  'guide.menuStartTour': 'ここからツアーを始める',
  'guide.menuTourList': 'ツアーの一覧',
  'guide.topicHome': 'ホーム',
  'guide.topicProtocol': 'プロトコル入力',
  'guide.topicBlocks': 'ブロック承認',
  'guide.topicSeeds': 'シード論文',
  'guide.topicDraft': '検索式（生成・検証）',
  'guide.topicExpand': '対話的シード拡張',
  'guide.topicEdit': '検索式編集',
  'guide.topicExport': 'エクスポート',
  'guide.topicDone': '完了',
  'guide.topicHistory': 'バージョン履歴',
  'guide.topicSettings': '設定',
  // ツアー: getting-started（手順の本文は、この区画の Desc の直後に足す）
  'guide.tourGettingStartedTitle': 'はじめての流れ',
  'guide.tourGettingStartedDesc': '画面の構成と、最初に開くプロトコル入力までを順に案内します。',
  'guide.tourGettingStartedStepWelcome': '左の一覧が作業の順番です。上から順に進めると、検索式ができあがります。',
  'guide.tourGettingStartedStepOpenProtocol': 'プロトコル入力を開いてください。研究の目的と組入・除外基準を入力する画面です。',
  'guide.tourGettingStartedStepFinish': 'ツアーはここからいつでも始め直せます。',
} as const;

/** 辞書キー（ja が正典。en は同一キー集合を型強制される） */
export type MessageKey = keyof typeof ja;
