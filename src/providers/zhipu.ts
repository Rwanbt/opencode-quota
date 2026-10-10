import { API_KEY_LOGIN_VENDORS } from "../lib/api-key-resolver.js";
import { queryZhipuQuota } from "../lib/zhipu.js";
import { createGlmCodingPlanProvider } from "./glm-coding-plan-provider.js";

export const zhipuProvider = createGlmCodingPlanProvider({
  id: "zhipu",
  providerId: "zhipu",
  errorLabel: "Zhipu",
  auth: API_KEY_LOGIN_VENDORS.zhipu,
  queryQuota: queryZhipuQuota,
  matchesCurrentModel(model) {
    const provider = model.toLowerCase().split("/")[0] ?? "";
    return provider.includes("zhipu") || provider === "glm-coding-plan";
  },
});
