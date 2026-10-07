import type { AgentHost, HostLaunchOptions } from "./host/contract.ts";
import { ClaudeHost } from "./hosts/claude/index.ts";
import { CodexHost } from "./hosts/codex/index.ts";

export interface E2eHostOptions {
  claude: HostLaunchOptions;
  codex: HostLaunchOptions;
}

export function createE2eHostOptions(): E2eHostOptions {
  // SDK の Options.persistSession と app-server の ThreadStartParams.ephemeral を使う。
  return { claude: { persistSession: false }, codex: { persistSession: false } };
}

// 保存先や認証の場所は変えず、公式の非保存指定だけを許す。
export function assertE2eIsolation(options: E2eHostOptions): void {
  for (const provider of ["claude", "codex"] as const) {
    if (options[provider].persistSession !== false) {
      throw new Error(`Unsafe E2E ${provider} launch: session persistence could write to the user's default history`);
    }
  }
}

function createHosts(settings: E2eHostOptions): readonly AgentHost[] {
  return [new ClaudeHost(undefined, settings.claude), new CodexHost(settings.codex)];
}

export function createE2eHosts(
  options = createE2eHostOptions(),
  factory: (options: E2eHostOptions) => readonly AgentHost[] = createHosts,
): readonly AgentHost[] {
  const settings = Object.freeze({
    claude: Object.freeze({ ...options.claude }),
    codex: Object.freeze({ ...options.codex }),
  });
  assertE2eIsolation(settings);
  return factory(settings);
}
