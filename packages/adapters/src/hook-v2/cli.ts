#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHookEvent, resolveHookGeneration, sendHook } from "./index.ts";
import type { HookSenderOptions } from "./index.ts";

export async function runHookV2(stdin: NodeJS.ReadableStream, options: HookSenderOptions = {}): Promise<void> {
  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  const input = JSON.parse(raw);
  const generation = await resolveHookGeneration(input, options.outbox);
  await sendHook(createHookEvent({ ...input, generation }), options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await runHookV2(process.stdin, { destinationFile: process.env.AGENT_GRAPH_HOOK_ENDPOINT_FILE });
  } catch (error) {
    console.error("agent-graph hook-v2:", error instanceof Error ? error.message : "Unable to persist hook");
    process.exitCode = 1;
  }
}
