import { API_KEY_LOGIN_VENDORS } from "./api-key-resolver.js";
import { queryGlmCodingPlanQuota } from "./glm-coding-plan.js";

const ZAI_QUOTA = {
  label: "Z.ai",
  endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
  httpErrorPrefix: "Z.ai API error",
  apiErrorPrefix: "Z.ai API error",
  envelope: "zai",
  auth: API_KEY_LOGIN_VENDORS.zai,
} as const;

export function queryZaiQuota(options: { requestTimeoutMs?: number; apiKey?: string } = {}) {
  return queryGlmCodingPlanQuota(ZAI_QUOTA, options);
}
