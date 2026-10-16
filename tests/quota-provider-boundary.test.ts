import { describe, expect, it } from "vitest";

import { listProviders as listModelsDevProviders } from "../src/lib/modelsdev-pricing.js";
import { QUOTA_PROVIDER_CATALOG } from "../src/lib/provider-metadata.js";
import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";
import { getProviders } from "../src/providers/registry.js";
import { PROVIDER_ROW_KEYS } from "./helpers/provider-assertions.js";

describe("quota provider boundary", () => {
  it("keeps registration, metadata, runtime, and row key boundaries complete", () => {
    const registrationIds = QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id);
    const quotaProviders = getProviders().map((p) => p.id);
    expect(Object.keys(QUOTA_PROVIDER_CATALOG)).toEqual(registrationIds);
    expect(quotaProviders).toEqual(registrationIds);
    expect(quotaProviders).toContain("deepseek");
    expect(quotaProviders).toContain("xiaomi");
    expect(Object.keys(PROVIDER_ROW_KEYS).sort()).toEqual([...quotaProviders].sort());
  });

  it("models.dev pricing providers include ids beyond quota provider support", () => {
    const quotaSet = new Set(getProviders().map((p) => p.id));
    const modelsDevProviders = listModelsDevProviders();
    const notInQuotaRegistry = modelsDevProviders.filter((id) => !quotaSet.has(id));
    expect(notInQuotaRegistry.length).toBeGreaterThan(0);
  });
});
