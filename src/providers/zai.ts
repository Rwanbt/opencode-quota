/** Z.ai provider wrapper. */

import { API_KEY_LOGIN_VENDORS } from "../lib/api-key-resolver.js";
import { queryZaiQuota } from "../lib/zai.js";
import { createGlmCodingPlanProvider } from "./glm-coding-plan-provider.js";

export const zaiProvider = createGlmCodingPlanProvider({
  id: "zai",
  providerId: "zai",
  errorLabel: "Z.ai",
  auth: API_KEY_LOGIN_VENDORS.zai,
  queryQuota: queryZaiQuota,
  matchesCurrentModel(model) {
    const lower = model.toLowerCase();
    const provider = lower.split("/")[0];
    if (provider && (provider.includes("zai") || provider.includes("glm"))) {
      return true;
    }
    return lower.includes("glm");
  },
});
