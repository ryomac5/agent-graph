import type { DatabaseSync } from "node:sqlite";
import type { Role } from "../delegate/types.ts";

export interface Performance {
  role: Role;
  model: string;
  samples: number;
  acceptRate: number;
  reviewApprove: number;
  avgRoundTrips: number;
  avgTokens: number;
}

export function aggregatePerformance(db: DatabaseSync, options: { role?: Role; since?: string } = {}): Performance[] {
  const rows = db.prepare(`
    SELECT d.role, a.model, COUNT(*) AS samples,
      AVG(CASE WHEN ac.passed IS NOT NULL THEN ac.passed END) AS accept_rate,
      AVG(CASE WHEN r.verdict IS NOT NULL THEN CASE WHEN r.verdict = 'approve' THEN 1.0 ELSE 0.0 END END) AS review_approve,
      AVG(d.round_trips) AS avg_round_trips,
      AVG(t.tokens) AS avg_tokens
    FROM delegations d
    JOIN assignments a ON a.delegation_id = d.id
    LEFT JOIN acceptances ac ON ac.delegation_id = d.id
    LEFT JOIN reviews r ON r.delegation_id = d.id
    LEFT JOIN (SELECT delegation_id, SUM(input_tokens + output_tokens) AS tokens
      FROM token_usage GROUP BY delegation_id) t ON t.delegation_id = d.id
    WHERE (? IS NULL OR d.role = ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM events e
        WHERE e.kind = 'delegation.requested' AND json_extract(e.payload, '$.delegationId') = d.id
          AND e.ts >= ?))
    GROUP BY d.role, a.model
    ORDER BY d.role, a.model
  `).all(options.role ?? null, options.role ?? null, options.since ?? null, options.since ?? null);
  return rows.map((row) => ({
    role: row.role as Role, model: row.model as string, samples: row.samples as number,
    acceptRate: row.accept_rate as number ?? 0,
    reviewApprove: row.review_approve as number ?? 0,
    avgRoundTrips: row.avg_round_trips as number ?? 0,
    avgTokens: row.avg_tokens as number ?? 0,
  }));
}
