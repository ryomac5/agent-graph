export const RETRY_MS: number;
export interface FeedHandlers {
  onData: (data: unknown) => void;
  onState: (state: "live" | "offline" | "connecting") => void;
  onError?: (message: string) => void;
}
export interface FeedDeps {
  fetch?: (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  EventSource?: unknown;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}
export interface Feed { close(): void; readonly live: boolean }
export function openFeed(key: string, handlers: FeedHandlers, deps?: FeedDeps): Feed;
