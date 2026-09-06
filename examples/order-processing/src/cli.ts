import { randomUUID } from "node:crypto";
import { DurableClient } from "@durable/client";
import type { OrderInput } from "./types.js";

export async function main(
  argv = process.argv.slice(2),
  env = process.env
): Promise<void> {
  const apiUrl = env.API_URL || "http://localhost:3000";
  const apiKey = env.API_KEY || "dev-key";
  const isDirect = argv.includes("--direct");

  const client = new DurableClient({ baseUrl: apiUrl, apiKey });

  const orderId = `ord_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const orderInput: OrderInput = {
    orderId,
    customerId: `cust_${randomUUID().replace(/-/g, "").slice(0, 6)}`,
    customerEmail: "buyer@example.com",
    items: [
      { sku: "ITEM-LAPTOP", quantity: 1, price: 1200.00 },
      { sku: "ITEM-MOUSE", quantity: 2, price: 25.00 }
    ],
    totalAmount: 1250.00
  };

  let runId: string;

  if (isDirect) {
    console.log(`\n🚀 Direct Mode: Starting workflow 'process-order'...`);
    const run = await client.startWorkflow("process-order", orderInput);
    runId = run.id;
    console.log(`Workflow Run Created: ${runId} (Status: ${run.status})`);
  } else {
    const eventId = `evt_${orderId}`;
    console.log(`\n📨 Event Mode: Dispatching 'order.created' event (${eventId})...`);
    const res = await client.sendEvent({
      name: "order.created",
      eventId,
      payload: orderInput
    });

    if (res.status === "duplicate" || !res.runs || res.runs.length === 0) {
      console.log(`Event status: ${res.status}. No new runs created.`);
      return;
    }

    const triggeredRun = res.runs[0];
    if (!triggeredRun) {
      console.log("No triggered run returned.");
      return;
    }
    runId = triggeredRun.id;
    console.log(`Workflow Run Triggered via Event Binding: ${runId}`);
  }

  console.log(`📡 Connecting to SSE stream for Run ID: ${runId}...`);
  for await (const event of client.runs.streamEvents(runId)) {
    const time = new Date().toISOString();
    console.log(
      `[${time}] ${event.eventType}${event.stepExecutionId ? ` (step: ${event.stepExecutionId})` : ""}`
    );

    if (event.eventType === "WORKFLOW_COMPLETED") {
      const finalRun = await client.runs.get(runId);
      console.log("\n==========================================");
      console.log("🎉 ORDER PROCESSING COMPLETED SUCCESSFULLY");
      console.log("==========================================");
      console.log("Order ID:   ", orderInput.orderId);
      console.log("Run ID:     ", runId);
      console.log("Trigger:    ", finalRun.triggerType ?? (isDirect ? "DIRECT" : "EVENT"));
      console.log("Output:     ", JSON.stringify(finalRun.output ?? event.payload, null, 2));
      console.log("==========================================\n");
      break;
    }

    if (event.eventType === "WORKFLOW_FAILED") {
      console.error("\n❌ Workflow execution failed:", event.payload);
      process.exitCode = 1;
      break;
    }
  }
}

const isDirectlyExecuted =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"));

if (isDirectlyExecuted) {
  main().catch((err) => {
    console.error("CLI Execution Error:", err);
    process.exit(1);
  });
}
