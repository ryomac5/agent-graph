import type { Language } from '../../lib/i18n.ts';

const text = {
  en: {
    loadOlder: 'Load older', agentReport: 'Agent report', command: 'Command', oldHistory: 'Older history is unavailable', projectInstructions: 'Project instructions', settingsInstructions: 'Configuration instructions', defaultModel: 'Recommended', recommended: 'Recommended', inUse: 'In use', toolsUsed: 'Used',
    conversation: 'Conversation', unknown: 'Unknown', source: 'Source', confidence: 'Confidence', streaming: 'Streaming', toolOutput: 'Tool output',
    show: 'Show full message', hide: 'Show first 8 lines', approval: 'Approval request', unavailable: 'Message unavailable',
    omitted: 'Message omitted by retention or storage policy', missing: 'Missing messages', timeUnknown: 'Time unknown',
    continued: 'Conversation continued', forked: 'Branch', compacted: 'Compaction', adopted: 'Handoff', evidence: 'Evidence',
    model: 'Model', effort: 'Effort', worktree: 'Worktree', coverage: 'Source', noRun: 'No run recorded', reason: 'Reason', lastEvidence: 'Last update',
    readOnly: 'Read-only', unsupported: 'Unable to continue from this conversation history.',
    input: 'Message', send: 'Send', shortcut: 'Send with ⌘ Enter', interrupt: 'Interrupt', apply: 'Apply model and effort',
    nextTurn: 'Codex model and effort changes apply from the next turn.', activeCodex: 'Available after this turn ends',
    claudeEffort: 'Effort changes apply to the next conversation.', fork: 'Branch conversation', handoff: 'Take over conversation',
    stopped: 'Have you stopped the external terminal?', confirm: 'Yes, resume here', branchInstead: 'No, continue in a branch', cancel: 'Cancel',
    cwd: 'Working directory', empty: 'No messages yet', pending: 'Sending…',
    failed: 'Command failed', noModels: 'No models available', chooseModel: 'Choose a model', noConversation: 'Conversation not found',
    yourTurn: 'Your turn', waitingReply: 'Waiting for your reply', needsAnswer: 'Needs your answer', backgroundWait: 'Waiting on a background task', working: 'Working', elapsed: 'Elapsed', waiting: 'Waiting', noCoverage: 'Source unknown', launchReady: 'Select a model and working directory.',
    user: 'User', assistant: 'Assistant', defaultEffort: 'Auto', applyShort: 'Apply', branchShort: 'Branch', takeOverShort: 'Take over',
    noModel: 'Not recorded', managedCoverage: 'Started here', observedCoverage: 'Terminal history', toolInput: 'Input', toolResult: 'Output',
    image: 'Image', noOutput: 'No output recorded', placeholder: 'Message the agent…', readOnlyPlaceholder: 'This conversation runs in a terminal. Take over to continue here.', sendHint: '⌘ Enter to send',
    noWorktree: 'Not recorded', thinking: 'Thinking', resolved: 'Resolved', expired: 'Expired', stale: 'Outdated', pendingState: 'Pending',
    answered: 'Answered', allowed: 'Allowed', denied: 'Denied',
    filesChanged: 'Files changed', difference: 'Diff', details: 'Details', historyFormat: 'History format', access: 'Access', parentAgent: 'Requesting agent', handoffUnsupported: 'Take over not supported',
  },
  ja: {
    yourTurn: 'あなたの番', waitingReply: 'あなたの返事を待っています', needsAnswer: '回答が必要です', backgroundWait: '裏の作業を待っています', working: '作業中',
    loadOlder: '古い発言を読み込む', agentReport: 'エージェントの報告', command: 'コマンド', oldHistory: '古い記録は読めません', projectInstructions: 'プロジェクトの指示', settingsInstructions: '設定の指示', defaultModel: 'おすすめ', recommended: 'おすすめ', inUse: '使用中', toolsUsed: 'ツールを使用',
    conversation: '会話', unknown: '不明', source: '送信元', confidence: '確かさ', streaming: '出力中', toolOutput: 'ツールの出力',
    show: '全文を開く', hide: '最初の 8 行だけ表示', approval: '承認リクエスト', unavailable: 'メッセージを読み込めません',
    omitted: '保存期間を過ぎたため本文はありません', missing: '読み込めなかったメッセージ', timeUnknown: '時刻不明',
    continued: '続きの会話', forked: '分岐', compacted: '文脈を要約しました', adopted: '引き継ぎ', evidence: '根拠',
    model: 'モデル', effort: '思考量', worktree: 'ワークツリー', coverage: '取得元', noRun: '実行の記録はありません', reason: '理由', lastEvidence: '最終更新',
    readOnly: '読み取り専用', unsupported: 'この会話の履歴からは続きを始められません。',
    input: '入力', send: '送信', shortcut: '⌘ Enter で送信', interrupt: '中断', apply: 'モデルと思考量を適用',
    nextTurn: 'Codex のモデルの変更は次の返答から効きます。', activeCodex: '返答が終わると変更できる',
    claudeEffort: '思考量の変更は次の会話から反映されます。', fork: '会話を分岐', handoff: '会話を引き継ぐ',
    stopped: '端末の会話を止めましたか？', confirm: 'はい、ここで再開', branchInstead: 'いいえ、分岐して続ける', cancel: 'キャンセル',
    cwd: '作業ディレクトリ', empty: 'まだメッセージはありません', pending: '送信中…',
    failed: '操作に失敗しました', noModels: 'モデルを取得できない', chooseModel: 'モデルを選択', noConversation: '会話が見つかりません',
    elapsed: '経過', waiting: '待ち', noCoverage: '取得元は不明です', launchReady: 'モデルと作業ディレクトリを選んでください。',
    user: 'ユーザー', assistant: 'エージェント', defaultEffort: '自動', applyShort: '適用', branchShort: '分岐', takeOverShort: '引き継ぐ',
    noModel: '記録なし', managedCoverage: 'ここで開始', observedCoverage: '端末の履歴', toolInput: '入力', toolResult: '出力',
    image: '画像', noOutput: '出力の記録はありません', placeholder: 'メッセージを入力…', readOnlyPlaceholder: 'この会話は端末で動いています。ここで続けるには引き継いでください。', sendHint: '⌘ Enter で送信',
    noWorktree: '記録なし', thinking: '思考', resolved: '解決済み', expired: '期限切れ', stale: '古い要求', pendingState: '保留中',
    answered: '回答済み', allowed: '許可', denied: '拒否',
    filesChanged: '変更したファイル', difference: '差分', details: '詳細', historyFormat: '履歴の形式', access: '操作', parentAgent: '依頼元', handoffUnsupported: '引き継ぎ非対応',
  },
};
export type ConversationText = keyof typeof text.en;
export function translate(language: Language, key: ConversationText): string { return text[language][key]; }

export function effortLabel(value: string, _language: Language): string { return value; }
export function toolsLabel(count: number, language: Language): string {
  return language === 'ja' ? `ツール ${count} 件` : `${count} ${count === 1 ? 'tool' : 'tools'}`;
}
