import type { Row } from '../../lib/store.ts';
import { readObject, readText } from './model.ts';

export function describeTool(tool: Row | undefined): string {
  const input = readObject(tool?.input);
  return readText(input.description) || readText(tool?.description) || readText(input.title);
}

export function waitsOnBackground(tool: Row | undefined): boolean {
  const input = readObject(tool?.input);
  return /^(?:Monitor|wait)$/i.test(readText(tool?.name)) || input.run_in_background === true || /(?:^|[\s/;&|])agc\s+wait(?:\s|$)/.test(readText(input.command));
}
