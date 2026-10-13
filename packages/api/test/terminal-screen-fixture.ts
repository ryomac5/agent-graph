export function promptFrame(provider = 'claude', text = ''): string {
  return provider === 'claude'
    ? `\x1b[2J\x1b[HClaude Code\r\n────────────────────────────────────────\r\n❯ ${text}\r\n────────────────────────────────────────\r\n  ? for shortcuts\x1b[3;3H`
    : `\x1b[2J\x1b[HOpenAI Codex\r\n\r\n› ${text}\r\n\r\n  ? for shortcuts                 100% context left\x1b[3;3H`;
}
export const HELP_PANEL = '\x1b[2J\x1b[H❯ /help\r\n────────────────────────────────────────\r\n  Help  General   Commands   Custom commands\r\n\r\n  Claude understands your codebase.\r\n  Esc to cancel\x1b[3;8H';
export const MODEL_PANEL = '\x1b[2J\x1b[H❯ /model\r\n────────────────────────────────────────\r\n  Select model\r\n  ❯ 1. Haiku\r\n  Enter to set as default · s to use this session only · Esc to cancel\x1b[4;3H';
