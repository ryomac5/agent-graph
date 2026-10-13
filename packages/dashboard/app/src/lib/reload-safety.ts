const blockers = new Set<symbol>();

// 発見待ちなど、通信が途切れる区間も送信操作全体を保護する。
export function holdDashboardReload() {
  const blocker = Symbol();
  blockers.add(blocker);
  return () => { blockers.delete(blocker); };
}
export function isDashboardReloadBlocked() { return blockers.size > 0; }
