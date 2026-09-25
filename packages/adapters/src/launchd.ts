import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_LABEL = "dev.agent-graph.daemon";

export interface LaunchdOptions {
  plistDir: string;
  nodePath: string;
  daemonPath: string;
  logDir: string;
  env?: Record<string, string | undefined>;
  label?: string;
  uid?: number;
  launchctl?: (args: string[]) => number;
}

export function renderInstallCommands(options: Pick<LaunchdOptions, "plistDir" | "label" | "uid">): string[][] {
  const label = options.label ?? DEFAULT_LABEL;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  return [["bootout", `gui/${uid}/${label}`], ["bootstrap", `gui/${uid}`, join(options.plistDir, `${label}.plist`)]];
}

export function renderUninstallCommands(options: Pick<LaunchdOptions, "plistDir" | "label" | "uid">): { commands: string[][]; plistPath: string } {
  const label = options.label ?? DEFAULT_LABEL;
  const plistPath = join(options.plistDir, `${label}.plist`);
  return { commands: [["bootout", `gui/${options.uid ?? process.getuid?.() ?? 0}`, plistPath]], plistPath };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function callLaunchctl(args: string[]): number {
  const result = spawnSync("launchctl", args, { stdio: "pipe" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function renderLaunchdPlist(options: Omit<LaunchdOptions, "plistDir" | "uid" | "launchctl">): string {
  const label = options.label ?? DEFAULT_LABEL;
  const env = { ...options.env, PATH: options.env?.PATH ?? process.env.PATH ?? "" };
  const variables = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${escapeXml(label)}</string>\n  <key>ProgramArguments</key><array><string>${escapeXml(options.nodePath)}</string><string>${escapeXml(options.daemonPath)}</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>${escapeXml(join(options.logDir, "daemon.stdout.log"))}</string>\n  <key>StandardErrorPath</key><string>${escapeXml(join(options.logDir, "daemon.stderr.log"))}</string>\n  <key>EnvironmentVariables</key><dict>\n${variables}\n  </dict>\n</dict>\n</plist>\n`;
}

export function installLaunchd(options: LaunchdOptions): void {
  const run = options.launchctl ?? callLaunchctl;
  const [bootout, bootstrap] = renderInstallCommands(options);
  const plistPath = bootstrap[2];
  mkdirSync(options.plistDir, { recursive: true });
  mkdirSync(options.logDir, { recursive: true });
  run(bootout);
  writeFileSync(plistPath, renderLaunchdPlist(options));
  if (run(bootstrap) !== 0) throw new Error(`launchctl bootstrap failed: ${plistPath}`);
}

export function uninstallLaunchd(options: Pick<LaunchdOptions, "plistDir" | "label" | "uid" | "launchctl">): void {
  const { commands, plistPath } = renderUninstallCommands(options);
  if (!existsSync(plistPath)) return;
  const run = options.launchctl ?? callLaunchctl;
  run(commands[0]);
  unlinkSync(plistPath);
}
