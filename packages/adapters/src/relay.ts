import { fileURLToPath } from "node:url";

export interface RelayOptions { shimPath: string; relay?: "legacy" | "v2" }

export function selectShim(options: RelayOptions): string {
  return options.relay === "v2" ? fileURLToPath(new URL("./shim-v2/cli.ts", import.meta.url)) : options.shimPath;
}
