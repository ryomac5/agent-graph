import { openLedger } from "../../core/src/ledger/index.ts";
import { serveRunner } from "./runtime.ts";
import { createE2eHosts } from "./e2e-isolation.ts";

async function run(): Promise<void> {
  if (process.env.AGENT_GRAPH_E2E !== "1") throw new Error("AGENT_GRAPH_E2E=1 is required");
  const hosts = createE2eHosts();
  const ledger = openLedger(process.argv[2]);
  let runner: Awaited<ReturnType<typeof serveRunner>> | undefined;
  let stop: () => void = () => {};
  try {
    runner = await serveRunner(ledger, process.argv[3], { hosts });
    console.log(JSON.stringify({ socket: process.argv[3] }));
    await new Promise<void>((resolve) => {
      stop = resolve;
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    try { await runner?.close(); } finally { ledger.close(); }
  }
}

run().catch((error: unknown) => { console.error("FAIL:", error); process.exitCode = 1; });
