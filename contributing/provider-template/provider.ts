/**
 * Template target: src/providers/<provider>.ts
 *
 * Wires provider availability, current-model matching and the row contract
 * (`src/providers/contract.ts`) into the quota provider registry. The API key comes from the
 * provider's entry in `API_KEY_VENDORS` (`src/lib/api-key-resolver.ts`).
 */

import { API_KEY_VENDORS, getApiKeyDiagnostics, hasApiKey } from "../lib/api-key-resolver.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { queryExampleProviderQuota } from "../lib/example-provider.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { DAILY, failedAccount, type ProviderFetchResult, quotaRow } from "./contract.js";
import { simpleApiKeyStatusDetails } from "./result-helpers.js";

const NAME = "Example Provider";

export const exampleProviderProvider: QuotaProvider = {
  id: "example-provider",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "example-provider",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasApiKey(API_KEY_VENDORS["example-provider"]);
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["example-provider", "example"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    // Where the key came from, for /quota_status. Never the key itself.
    const diagnostics = await getApiKeyDiagnostics(API_KEY_VENDORS["example-provider"]).catch(
      () => ({ configured: false, source: null, checkedPaths: [], credentialDatabasePaths: [] }),
    );
    const debug = simpleApiKeyStatusDetails(diagnostics);

    const result = await queryExampleProviderQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });
    if (!result) return { attempted: false, accounts: [], debug };
    if (!result.success) {
      return { attempted: true, accounts: [failedAccount(NAME, result.error)], debug };
    }

    // Row id `example-provider.daily`: users' hide, rename and order settings use it.
    const row = quotaRow({
      ...DAILY,
      percentRemaining: result.percentRemaining,
      resetsAt: result.resetTimeIso,
    });
    return { attempted: true, accounts: [{ name: NAME, rows: [row], errors: [] }], debug };
  },
};
