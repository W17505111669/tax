import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * 工具注册表：每个业务 Agent 只能拿到自己注册的工具，
 * Pi 内置的 read/bash/edit/write 一律禁用（见 agent-factory.ts 的 noTools）。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) throw new Error(`工具重名: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: ToolDefinition[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
