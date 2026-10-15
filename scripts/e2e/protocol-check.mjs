import assert from 'node:assert/strict';
import { assertIsolation } from './isolation.mjs';
await assertIsolation();
const { ClaudeHost } = await import('../../packages/runner/src/hosts/claude/index.ts');
const { CodexHost } = await import('../../packages/runner/src/hosts/codex/index.ts');
const claude = new ClaudeHost();
const codex = new CodexHost();
try {
  assert.deepEqual((await claude.listModels()).map(row => row.model), ['sonnet', 'haiku']);
  assert.deepEqual((await codex.listModels()).map(row => row.model), ['gpt-6-sol']);
  console.log('Synthetic SDK/app-server model discovery: PASS');
} finally { await codex.dispose(); }
