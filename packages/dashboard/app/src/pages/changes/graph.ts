export interface GraphCommit { hash: string; parents: string[] }
export interface GraphSegment { from: number; to: number; half: 'top' | 'bottom'; lane: number }
export interface GraphRow { column: number; segments: GraphSegment[] }

// 列を詰めず、合流した列の空きだけを再利用して行間の線をつなぐ。
export function buildCommitGraph(commits: GraphCommit[]): { rows: GraphRow[]; columns: number } {
  const lanes: (string | undefined)[] = [];
  let columns = 1;
  const rows = commits.map(commit => {
    const before = [...lanes];
    let column = lanes.indexOf(commit.hash);
    if (column < 0) {
      column = lanes.indexOf(undefined);
      if (column < 0) column = lanes.length;
      lanes[column] = commit.hash;
    }
    const segments: GraphSegment[] = [];
    before.forEach((hash, lane) => {
      if (hash) segments.push({ from: lane, to: lane, half: 'top', lane });
    });
    lanes[column] = undefined;
    for (const parent of new Set(commit.parents)) {
      let target = lanes.indexOf(parent);
      if (target < 0) {
        target = lanes[column] === undefined ? column : lanes.indexOf(undefined);
        if (target < 0) target = lanes.length;
        lanes[target] = parent;
      }
      segments.push({ from: column, to: target, half: 'bottom', lane: target });
    }
    before.forEach((hash, lane) => {
      if (hash && lane !== column) segments.push({ from: lane, to: lane, half: 'bottom', lane });
    });
    columns = Math.max(columns, lanes.length, column + 1);
    return { column, segments };
  });
  return { rows, columns };
}
