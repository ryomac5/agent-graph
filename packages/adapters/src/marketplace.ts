import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderClaudePlugin, type ClaudePluginOptions } from "./claude-plugin.ts";

export interface MarketplaceOptions { outDir: string; plugin: Omit<ClaudePluginOptions, "outDir"> }

export function renderMarketplace(options: MarketplaceOptions): Record<string, string> {
  const manifest = JSON.stringify({
    name: "agent-graph-local",
    owner: { name: "agent-graph" },
    plugins: [{ name: "agent-graph", source: "./plugins/agent-graph" }],
  }, null, 2) + "\n";
  const plugin = renderClaudePlugin({ outDir: join(options.outDir, "plugins", "agent-graph"), ...options.plugin });
  return { ".claude-plugin/marketplace.json": manifest, ...Object.fromEntries(Object.entries(plugin).map(([path, content]) => [`plugins/agent-graph/${path}`, content])) };
}

export function generateMarketplace(options: MarketplaceOptions): void {
  for (const [relativePath, content] of Object.entries(renderMarketplace(options))) {
    const path = join(options.outDir, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
}
