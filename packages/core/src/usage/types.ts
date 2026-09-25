export interface UsageSample {
  ts: string;
  provider: "anthropic" | "openai";
  window: string;
  percent: number;
  resetsAt?: string;
  model?: string;
}
