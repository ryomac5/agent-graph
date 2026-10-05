import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function quoteShell(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

export function installShellCommands(home: string, shell: string | undefined, entries: string[], root: string): void {
  const profile = join(home, shell?.endsWith("/bash") ? ".bash_profile" : ".zprofile");
  const existing = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  const block = `# >>> agent-graph PATH\nexport PATH=${quoteShell([...new Set(entries)].join(":"))}:"$PATH"\n# <<< agent-graph PATH\n`;
  const pattern = /^# >>> agent-graph PATH\r?\n[\s\S]*?^# <<< agent-graph PATH(?:\r?\n|$)/m;
  if (existing.includes("# >>> agent-graph PATH") && !pattern.test(existing)) throw new Error(`PATH設定の区切りが不完全です: ${profile}`);
  const updated = pattern.test(existing) ? existing.replace(pattern, () => block) : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}`;
  if (updated !== existing) {
    mkdirSync(home, { recursive: true });
    if (existsSync(profile)) copyFileSync(profile, `${profile}.agent-graph.bak`);
    writeFileSync(profile, updated);
  }
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, "agent-graph");
  const content = `#!/bin/bash\n# agent-graph managed launcher\nexec /bin/bash ${quoteShell(join(root, "scripts", "setup.sh"))} "$@"\n`;
  const current = existsSync(launcher) ? readFileSync(launcher, "utf8") : "";
  if (current && !current.includes("# agent-graph managed launcher")) throw new Error(`既存のコマンドを上書きしません: ${launcher}`);
  if (current !== content) writeFileSync(launcher, content, { mode: 0o755 });
}
