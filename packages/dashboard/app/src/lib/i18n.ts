export const dictionaries = {
  en: {
    english: 'English', japanese: '日本語', brand: 'agent-graph', workspace: 'Workspace', overview: 'Overview', projects: 'Projects',
    inbox: 'Approvals', tree: 'Sub-agents', changes: 'Changes', search: 'Search', settings: 'Settings',
    conversation: 'Conversation', conversations: 'Conversations', project: 'Project', notifications: 'Notifications',
    noNotifications: 'No notifications yet', noProjects: 'No projects yet',
    emptyTitle: 'Nothing here yet',
    futureTitle: 'Not available yet',
    connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', runner_unavailable: 'Runner offline',
    approvals: 'Approvals', theme: 'Theme', system: 'System', light: 'Light', dark: 'Dark', language: 'Language',
    starting: 'Starting', running: 'Running', waiting_approval: 'Needs approval', waiting_input: 'Waiting', idle: 'Idle',
    ended: 'Done', failed: 'Failed', unknown: 'Unknown', evidence: 'Details', notFound: 'Page not found',
    requests: 'Sub-agents', noRequests: 'No sub-agents yet', noConversations: 'No conversations yet', newTask: 'New task',
    back: 'Back to', showRequests: 'Show sub-agents', hideRequests: 'Hide sub-agents',
    agentsRunning: 'agents running', agentRunning: 'agent running', viewAll: 'View all conversations', unattended: 'Background',
    other: 'Other', agent: 'Agent', commands: 'Search and commands', retry: 'Retry', showOlder: 'Earlier',
  },
  ja: {
    english: 'English', japanese: '日本語', brand: 'agent-graph', workspace: '作業場', overview: '一覧', projects: 'プロジェクト',
    inbox: '承認待ち', tree: 'サブエージェント', changes: '変更', search: '検索', settings: '設定',
    conversation: '会話', conversations: '会話', project: 'プロジェクト', notifications: '通知',
    noNotifications: '通知はまだありません', noProjects: 'プロジェクトはまだありません',
    emptyTitle: 'まだ何もありません',
    futureTitle: 'まだ使えません',
    connecting: '接続中', connected: '接続済み', reconnecting: '再接続中', runner_unavailable: 'ランナーに接続できません',
    approvals: '承認待ち', theme: 'テーマ', system: 'OS に合わせる', light: 'ライト', dark: 'ダーク', language: '言語',
    starting: '起動中', running: '実行中', waiting_approval: '承認待ち', waiting_input: '返答待ち', idle: '待機中',
    ended: '完了', failed: '失敗', unknown: '不明', evidence: '詳細', notFound: 'ページが見つかりません',
    requests: 'サブエージェント', noRequests: 'まだサブエージェントはいません', noConversations: 'まだ会話はありません', newTask: '新規タスク',
    back: '戻る:', showRequests: 'サブエージェントを開く', hideRequests: 'サブエージェントを畳む',
    agentsRunning: '件が実行中', agentRunning: '件が実行中', viewAll: 'すべての会話を見る', unattended: '自動実行',
    other: 'その他', agent: 'エージェント', commands: 'コマンドと検索', retry: '再試行', showOlder: '以前',
  },
} as const;
export type Language = keyof typeof dictionaries;
export type TextKey = keyof typeof dictionaries.en;

export const graphText = {
  en: { running: 'running', needsYou: 'needs you', today: 'Today', earlier: 'Earlier', showMore: 'Show 20 more',
    inferred: 'Inferred', allow: 'Allow', deny: 'Deny', requests: 'Request graph', request: 'Request', who: 'Who',
    now: 'Now', range: 'Time range', report: 'Report', elapsed: 'Elapsed', rounds: 'Rounds', close: 'Close details', open: 'Open conversation' },
  ja: { running: '実行中', needsYou: 'あなたの番', today: '今日', earlier: '以前', showMore: 'さらに20件表示',
    inferred: '推定', allow: '許可', deny: '拒否', requests: '依頼のグラフ', request: '依頼', who: '相手',
    now: '現在', range: '期間', report: '報告', elapsed: '経過', rounds: '往復', close: '詳細を閉じる', open: '会話を開く' },
} as const;
