export const dictionaries = {
  en: {
    english: 'English', japanese: '日本語', brand: 'agent-graph', workspace: 'Workspace', overview: 'Overview', projects: 'Projects',
    inbox: 'Approval inbox', tree: 'Delegation tree', changes: 'Changes', search: 'Search', settings: 'Settings',
    conversation: 'Conversation', project: 'Project workspace', notifications: 'Notifications',
    noNotifications: 'No notifications yet', noProjects: 'No projects yet',
    emptyTitle: 'Your workspace is ready', emptyBody: 'Activity will appear here as agents connect.',
    futureTitle: 'This view is coming next', futureBody: 'This workspace is reserved for the next implementation stage.',
    connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', runner_unavailable: 'Runner unavailable',
    approvals: 'Pending approvals', theme: 'Appearance', system: 'System', light: 'Light', dark: 'Dark', language: 'Language',
    running: 'Running', waiting_approval: 'Waiting for approval', waiting_input: 'Waiting for input', idle: 'Idle',
    ended: 'Ended', failed: 'Failed', unknown: 'Unknown', evidence: 'Evidence', notFound: 'Page not found',
    themeHint: 'Follows the operating system unless you choose one.', languageHint: 'Interface language for this browser.',
  },
  ja: {
    english: 'English', japanese: '日本語', brand: 'agent-graph', workspace: '作業場', overview: '一覧', projects: 'プロジェクト',
    inbox: '承認の受け箱', tree: '委譲の木', changes: '変更', search: '検索', settings: '設定',
    conversation: '会話', project: 'プロジェクトの作業場', notifications: '通知',
    noNotifications: '通知はまだありません', noProjects: 'プロジェクトはまだありません',
    emptyTitle: '作業場の準備ができました', emptyBody: 'エージェントが接続すると、活動がここに表示されます。',
    futureTitle: '次の段階で利用できます', futureBody: 'この画面は次の実装段階のために用意されています。',
    connecting: '接続中', connected: '接続済み', reconnecting: '再接続中', runner_unavailable: 'runner 不在',
    approvals: '承認待ち', theme: '配色', system: 'OS に従う', light: '明るい', dark: '暗い', language: '言語',
    running: '実行中', waiting_approval: '承認待ち', waiting_input: '入力待ち', idle: '待機',
    ended: '終了', failed: '失敗', unknown: '不明', evidence: '根拠', notFound: '画面が見つかりません',
    themeHint: '選ばなければ OS の設定に従います。', languageHint: 'このブラウザでの画面の言語です。',
  },
} as const;
export type Language = keyof typeof dictionaries;
export type TextKey = keyof typeof dictionaries.en;
