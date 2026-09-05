import type { WorkflowDefinition } from "@durable/workflow-sdk";

export class WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowDefinition<any, any>>();

  private toKey(name: string, version: string): string {
    return `${name}:${version}`;
  }

  register(workflow: WorkflowDefinition<any, any>): void {
    const key = this.toKey(workflow.config.name, workflow.config.version);
    this.workflows.set(key, workflow);
  }

  get(name: string, version: string): WorkflowDefinition<any, any> | undefined {
    return this.workflows.get(this.toKey(name, version));
  }
}
