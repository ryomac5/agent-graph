export function promptFrame(provider = 'claude', text = ''): string {
  return provider === 'claude'
    ? `\x1b[2J\x1b[HClaude Code\r\n────────────────────────────────────────\r\n❯ ${text}\r\n────────────────────────────────────────\r\n  ? for shortcuts\x1b[3;3H`
    : `\x1b[2J\x1b[HOpenAI Codex\r\n\r\n› ${text}\r\n\r\n  ? for shortcuts                 100% context left\x1b[3;3H`;
}
export const HELP_PANEL = '\x1b[2J\x1b[H❯ /help\r\n────────────────────────────────────────\r\n  Help  General   Commands   Custom commands\r\n\r\n  Claude understands your codebase.\r\n  Esc to cancel\x1b[3;8H';
export const MODEL_PANEL = '\x1b[2J\x1b[H❯ /model\r\n────────────────────────────────────────\r\n  Select model\r\n  ❯ 1. Haiku\r\n  Enter to set as default · s to use this session only · Esc to cancel\x1b[4;3H';
export const COST_PANEL = '\x1b[2J\x1b[H❯ /cost\r\n────────────────────────────────────────\r\n  Settings  Status   Config   Usage   Stats\r\n\r\n  Session\r\n  Total cost: $0.0000\r\n  Esc to cancel\x1b[3;3H';
export const PERMISSION_PANEL = '\x1b[2J\x1b[H────────────────────────────────────────\r\n  Do you want to proceed?\r\n  ❯ 1. Yes\r\n    2. No\r\n  Esc to cancel\x1b[3;3H';
export const BASH_PERMISSION_PANEL = "\x1b[2J\x1b[H────────────────────────────────────────\r\n  Bash command\r\n  echo hello\r\n────────────────────────────────────────\r\n  Do you want to proceed?\r\n  ❯ 1. Yes\r\n    2. Yes, and don't ask again for echo commands\r\n    3. No, and tell Claude what to do differently (esc)\x1b[6;3H";
export const SELECTION_PANEL = '\x1b[2J\x1b[H────────────────────────────────────────\r\n  Select an option\r\n  ❯ 1. First\r\n    2. Second\r\n  Enter to select · Esc to cancel\x1b[3;3H';
