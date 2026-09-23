import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeConfig } from "./config.ts";

export type TaxModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

let cached: { runtime: ModelRuntime; model: TaxModel; key: string } | undefined;

/** 创建（或复用）ModelRuntime，并解析出配置指定的模型。 */
export async function getModelRuntime(cfg: RuntimeConfig): Promise<{
  runtime: ModelRuntime;
  model: TaxModel;
}> {
  const key = `${cfg.baseUrl}|${cfg.modelId}|${cfg.api}`;
  if (cached && cached.key === key) return { runtime: cached.runtime, model: cached.model };

  const runtime = await ModelRuntime.create({
    modelsPath: cfg.modelsPath,
    authPath: cfg.authPath,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });

  const model = runtime.getModel(cfg.providerId, cfg.modelId);
  if (!model) {
    const known = runtime.getModels().map((m) => `${m.provider}/${m.id}`).join(", ");
    throw new Error(`模型未注册: ${cfg.providerId}/${cfg.modelId}。已知模型: ${known || "(空)"}`);
  }

  cached = { runtime, model, key };
  return { runtime, model };
}
