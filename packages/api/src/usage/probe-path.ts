import { homedir } from 'node:os';
import { join } from 'node:path';

export const USAGE_PROBE_PATH = join(homedir(), '.cache/agent-graph/usage-probe');

export const VISIBLE_CONVERSATION_SQL = `NOT (coalesce(t.cwd, '') = '${USAGE_PROBE_PATH.replaceAll("'", "''")}' AND coalesce(t.type, '') = 'unattended')`;
