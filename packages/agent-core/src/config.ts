import fs from "node:fs";
import path from "node:path";

export interface RuntimeConfig {
  /** 项目根目录（monorepo root）。 */
  rootDir: string;
  /** Pi 的隔离配置目录，避免读取或污染用户的 ~/.pi。 */
  agentDir: string;
  /** 生成的 models.json 路径。 */
  modelsPath: string;
  authPath: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  modelId: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
  /** 额外加载的 Pi 社区扩展入口文件（如 pi-web-access）。 */
  extensionPaths: string[];
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/**
 * 从环境变量构建运行配置，并把模型端点写入项目内的 models.json。
 * Pi SDK 通过 models.json 识别 OpenAI 兼容端点，这样密钥不会出现在代码里。
 */
export function loadRuntimeConfig(rootDir?: string): RuntimeConfig {
  const resolvedRoot = rootDir ?? findRoot();
  const agentDir = path.join(resolvedRoot, "data", "agent-home");
  fs.mkdirSync(agentDir, { recursive: true });

  const cfg: RuntimeConfig = {
    rootDir: resolvedRoot,
    agentDir,
    modelsPath: path.join(agentDir, "models.json"),
    authPath: path.join(agentDir, "auth.json"),
    providerId: "taxai",
    baseUrl: env("TAXAI_BASE_URL", "http://127.0.0.1:15721/v1"),
    apiKey: env("TAXAI_API_KEY", "PROXY_MANAGED"),
    api: env("TAXAI_API", "openai-responses"),
    modelId: env("TAXAI_MODEL", "qwen3.8-max"),
    thinkingLevel: env("TAXAI_THINKING", "low") as RuntimeConfig["thinkingLevel"],
    extensionPaths: env("TAXAI_PI_EXTENSIONS", "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };

  writeModelsJson(cfg);
  writeWebSearchConfig(cfg);
  return cfg;
}

function writeModelsJson(cfg: RuntimeConfig): void {
  const models = {
    providers: {
      [cfg.providerId]: {
        name: "TaxAI Gateway",
        baseUrl: cfg.baseUrl,
        api: cfg.api,
        apiKey: cfg.apiKey,
        models: [
          {
            id: cfg.modelId,
            name: cfg.modelId,
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 262144,
            maxTokens: 32768,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  fs.writeFileSync(cfg.modelsPath, JSON.stringify(models, null, 2), "utf8");
}

/**
 * pi-web-access 社区扩展的配置文件（位于隔离 agentDir 内）。
 * 默认开启网页抓取类工具；搜索 provider 由扩展自动降级链决定（Exa MCP 零配置可用）。
 */
function writeWebSearchConfig(cfg: RuntimeConfig): void {
  const file = path.join(cfg.agentDir, "web-search.json");
  if (fs.existsSync(file)) return; // 允许人工覆盖
  const config = {
    webSearch: { enabled: true },
    tools: {
      fetchContent: { enabled: true },
      getSearchContent: { enabled: true },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
}

function findRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
