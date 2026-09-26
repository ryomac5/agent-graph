export const TOKEN_META_NAME: string;
export const TOKEN_HEADER: string;
export interface ActionOutcome { ok: boolean; message: string }
export interface ActionDeps {
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  token?: string;
  notify?: (message: string) => void;
}
export function readToken(doc?: unknown): string;
export function sendAction(body: Record<string, unknown>, deps?: ActionDeps): Promise<ActionOutcome>;
