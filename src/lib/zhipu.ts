import { API_KEY_LOGIN_VENDORS } from "./api-key-resolver.js";
import { queryGlmCodingPlanQuota } from "./glm-coding-plan.js";

const ZHIPU_QUOTA = {
  label: "Zhipu",
  endpoint: "https://bigmodel.cn/api/monitor/usage/quota/limit",
  httpErrorPrefix: "Zhipu API error",
  envelope: "zhipu",
  auth: API_KEY_LOGIN_VENDORS.zhipu,
} as const;

export function queryZhipuQuota(options: { requestTimeoutMs?: number; apiKey?: string } = {}) {
  return queryGlmCodingPlanQuota(ZHIPU_QUOTA, options);
}
