/**
 * Which providers serve a session's model. Shared by the v5 surfaces and the v6 snapshot, which
 * names the providers of the current model (`currentModelProviderIds`).
 */
import type { QuotaProvider } from "../lib/entries.js";
import {
  getQuotaProviderIdsForRuntimeId,
  getQuotaProviderShape,
} from "../lib/provider-metadata.js";
import type { QuotaToastConfig } from "../lib/types.js";

export function matchesQuotaProviderCurrentSelection(params: {
  provider: QuotaProvider;
  currentModel?: string;
  currentProviderID?: string;
  enabledProviders?: string[] | "auto";
  quotaProviders?: QuotaToastConfig["quotaProviders"];
}): boolean {
  const matchesCurrentModel = (model: string): boolean =>
    params.provider.matchesCurrentModel
      ? params.provider.matchesCurrentModel(model, {
          enabledProviders: params.enabledProviders ?? "auto",
          ...(params.quotaProviders ? { quotaProviders: params.quotaProviders } : {}),
          ...(params.currentProviderID ? { currentProviderID: params.currentProviderID } : {}),
        })
      : true;

  if (params.provider.id === "quota-providers") {
    if (params.currentModel) return matchesCurrentModel(params.currentModel);
    if (!params.currentProviderID) return false;

    return Boolean(
      params.quotaProviders?.some(
        (source) => source.providerId === params.currentProviderID && source.modelIds === undefined,
      ),
    );
  }

  if (params.currentProviderID) {
    const explicitId = params.currentProviderID.trim().toLowerCase();
    const catalogShape = getQuotaProviderShape(explicitId);
    if (catalogShape?.id === explicitId) return params.provider.id === catalogShape.id;

    const runtimeCandidates = getQuotaProviderIdsForRuntimeId(explicitId);
    if (runtimeCandidates.length === 1) return params.provider.id === runtimeCandidates[0];
    if (runtimeCandidates.length > 1) {
      if (!runtimeCandidates.some((candidate) => candidate === params.provider.id)) {
        return false;
      }
      if (!params.currentModel || !params.provider.matchesCurrentModel) return false;

      const qualifiedModel = params.currentModel.toLowerCase().startsWith(`${explicitId}/`)
        ? params.currentModel
        : `${explicitId}/${params.currentModel}`;
      return matchesCurrentModel(qualifiedModel);
    }

    return false;
  }

  return params.currentModel ? matchesCurrentModel(params.currentModel) : false;
}
