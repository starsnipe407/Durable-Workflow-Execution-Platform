import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  createWorkflowQueue,
  enqueueWorkflowRun,
  WORKFLOW_QUEUE_NAME,
  WORKFLOW_JOB_NAME,
} from "../src/index.js";
import type { Queue } from "bullmq";
import type { WorkflowRunJobData } from "../src/types.js";

describe("Queue Producer", () => {
  let queue: Queue<WorkflowRunJobData>;

  beforeAll(async () => {
    queue = createWorkflowQueue(process.env.REDIS_URL || "redis://localhost:6380");
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("enqueues a workflow run job with correct name and descriptor", async () => {
    const jobData: WorkflowRunJobData = {
      tenantId: "t-1",
      runId: "r-1",
      workflowName: "wf-1",
      workflowVersion: "v1",
    };

    const job = await enqueueWorkflowRun(queue, jobData);
    expect(job).toBeDefined();
    expect(job.name).toBe("workflow-replay");
    expect(job.data).toEqual(jobData);

    const fetchedJob = await queue.getJob(job.id!);
    expect(fetchedJob).toBeDefined();
    expect(fetchedJob?.name).toBe("workflow-replay");
    expect(fetchedJob?.data).toEqual(jobData);
  });

  it("enqueues a delayed job and enters delayed state", async () => {
    const jobData: WorkflowRunJobData = {
      tenantId: "t-1",
      runId: "r-2",
      workflowName: "wf-1",
      workflowVersion: "v1",
    };

    const job = await enqueueWorkflowRun(queue, jobData, { delay: 5000 });
    expect(job).toBeDefined();
    const state = await job.getState();
    expect(state).toBe("delayed");
  });
});
