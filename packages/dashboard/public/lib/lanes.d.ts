export interface LaneRow { col: number; before: (string | null)[]; after: (string | null)[]; edges: number[] }
export function layoutLanes(commits: { sha: string; parents?: string[] }[]): { rows: LaneRow[]; width: number };
