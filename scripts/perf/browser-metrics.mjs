export function isLastMessageVisible() {
  const root = document.querySelector('.workbench-body:not([hidden])');
  const box = root?.querySelector('.conv-timeline');
  const article = [...root?.querySelectorAll('article.message') ?? []].at(-1);
  if (!box || !article || root.querySelector('.history-loading')) return false;
  const a = article.getBoundingClientRect(), b = box.getBoundingClientRect();
  return a.bottom > b.top && a.top < b.bottom;
}

export async function measureConversationScroll() {
  const box = document.querySelector('.workbench-body:not([hidden]) .conv-timeline');
  const metrics = window.__perf;
  const commits = metrics.commits, work = metrics.workFibers, task = metrics.longTasks.length;
  const frames = []; let previous = performance.now(); const start = previous;
  for (let step = 0; step < 120; step++) {
    box.scrollTop = Math.max(0, box.scrollTop - 150);
    box.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise(resolve => requestAnimationFrame(now => { frames.push(now - previous); previous = now; resolve(); }));
  }
  return { ms: performance.now() - start, frames, commits: metrics.commits - commits,
    workFibers: metrics.workFibers - work, longTasks: metrics.longTasks.slice(task),
    messages: box.querySelectorAll('article.message').length };
}
