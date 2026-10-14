import { homedir } from 'node:os';
import { join } from 'node:path';

export const USAGE_PROBE_PATH = join(homedir(), '.cache/agent-graph/usage-probe');

export const VISIBLE_CONVERSATION_SQL = `NOT (coalesce(t.cwd, '') = '${USAGE_PROBE_PATH.replaceAll("'", "''")}' AND coalesce(t.type, '') = 'unattended')
  AND NOT EXISTS (SELECT 1 FROM projection_records visibility
    WHERE visibility.projection = 'conversations' AND visibility.entity_id = t.id
      AND json_extract(visibility.data, '$.hidden') = 1)`;
