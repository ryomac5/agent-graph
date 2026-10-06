// コミットのツリーの線の配置。git log --graph と同じ考えで、各行に列と上下の線を決める。DOM に触れない。
// commits は子が親より先に並ぶトポロジー順。各行の before は行の上端で各列が待っているコミット、after は下端の状態

function freeColumn(lanes) {
  const index = lanes.indexOf(null);
  return index < 0 ? lanes.length : index;
}

export function layoutLanes(commits) {
  const lanes = [];
  const rows = [];
  let width = 1;
  for (const commit of commits) {
    const before = lanes.slice();
    let col = lanes.indexOf(commit.sha);
    if (col < 0) { col = freeColumn(lanes); lanes[col] = commit.sha; }
    // 同じコミットを待っていた別の列は、ここで合流させて空ける
    const merging = [];
    lanes.forEach((sha, index) => { if (sha === commit.sha && index !== col) { merging.push(index); lanes[index] = null; } });
    const parents = commit.parents || [];
    const edges = [];
    lanes[col] = null;
    parents.forEach((parent, order) => {
      let target = lanes.indexOf(parent);
      if (target < 0) {
        // 一次の親は自分の列を引き継ぐ。ほかの親は空いた列に出す
        target = order === 0 ? col : freeColumn(lanes);
        lanes[target] = parent;
      }
      edges.push(target);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const after = lanes.slice();
    rows.push({ col, before, after, edges });
    width = Math.max(width, before.length, after.length, col + 1);
  }
  return { rows, width };
}
