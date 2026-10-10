import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderDiagnostic,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { mapWithConcurrency } from "../lib/map-with-concurrency.js";
import type {
  LocalEstimateQuotaProviderDefinition,
  QuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../lib/quota-providers.js";
import {
  customQuotaProviderDefinitions,
  QUOTA_PROVIDERS_AGGREGATE_ID,
  resolveQuotaProviderSessionModelIdentity,
  selectEligibleQuotaProviderDefinitions,
} from "../lib/quota-providers.js";
import {
  collectLocalQuotaProviderEstimate,
  inspectLocalQuotaProviderState,
} from "../lib/quota-providers-local.js";
import {
  fetchRemoteQuotaProvider,
  type QuotaProviderAuthSource,
  resolveQuotaProviderApiKey,
} from "../lib/quota-providers-remote.js";

const DEFINITION_CONCURRENCY = 4;

const CREDENTIAL_SOURCES: Record<
  QuotaProviderAuthSource,
  QuotaProviderDiagnostic["credentialSource"]
> = {
  env: "explicit_env",
  "opencode.json": "global_opencode_json",
  "opencode.jsonc": "global_opencode_jsonc",
  "opencode.db": "opencode_db",
};

type InstanceResult = {
  entries: QuotaProviderResult["entries"];
  errors: QuotaProviderResult["errors"];
  diagnostic: QuotaProviderDiagnostic;
};

type DiagnosticOutcome = Pick<
  QuotaProviderDiagnostic,
  "attempted" | "credentialSource" | "outcome" | "httpStatus" | "entryCount"
>;

function buildDiagnostic(
  definition: QuotaProviderDefinition,
  outcome: DiagnosticOutcome,
  paths: Pick<QuotaProviderDiagnostic, "checkedPaths" | "credentialDatabasePaths"> = {
    checkedPaths: [],
    credentialDatabasePaths: [],
  },
): QuotaProviderDiagnostic {
  return {
    sourceId: definition.id,
    providerId: definition.providerId,
    mode: definition.mode,
    ...(definition.mode === "remote-api" ? { format: definition.format } : {}),
    modelIds: definition.modelIds ? [...definition.modelIds] : null,
    apiKeyEnv: definition.mode === "remote-api" ? (definition.apiKeyEnv ?? null) : null,
    selected: true,
    ...outcome,
    checkedPaths: [...paths.checkedPaths],
    credentialDatabasePaths: [...paths.credentialDatabasePaths],
  };
}

function selectDefinitions(
  ctx: QuotaProviderContext,
  availableProviderIds: ReadonlySet<string>,
): QuotaProviderDefinition[] {
  return selectEligibleQuotaProviderDefinitions({
    definitions: ctx.config.quotaProviders ?? [],
    availableProviderIds,
    onlyCurrentModel: ctx.config.onlyCurrentModel,
    currentModel: ctx.config.currentModel,
    currentProviderID: ctx.config.currentProviderID,
  });
}

function classifyRuntimeError(error: string): Pick<DiagnosticOutcome, "outcome" | "httpStatus"> {
  if (error === "Redirect rejected") return { outcome: "redirect_error" };
  if (error.startsWith("Request timeout after ")) return { outcome: "timeout" };
  if (error === "Response exceeded 262144 bytes") return { outcome: "body_too_large" };
  if (error === "Expected a JSON response") return { outcome: "invalid_content_type" };
  if (error === "Invalid JSON response") return { outcome: "invalid_json" };
  if (error.startsWith("Invalid ")) return { outcome: "invalid_response" };
  const status = /^HTTP (\d+)$/.exec(error);
  if (status) return { outcome: "http_error", httpStatus: Number(status[1]) };
  return { outcome: "network_error" };
}

async function executeRemote(
  definition: RemoteApiQuotaProviderDefinition,
  requestTimeoutMs?: number,
): Promise<InstanceResult> {
  const auth = await resolveQuotaProviderApiKey(definition);
  if (!auth.key) {
    return {
      entries: [],
      errors: [{ label: definition.label, message: "API key not configured" }],
      diagnostic: buildDiagnostic(
        definition,
        { attempted: false, credentialSource: null, outcome: "missing_credential", entryCount: 0 },
        auth,
      ),
    };
  }

  const credentialSource = auth.source ? CREDENTIAL_SOURCES[auth.source] : null;
  const result = await fetchRemoteQuotaProvider(definition, auth.key, requestTimeoutMs);
  if (!result.success) {
    return {
      entries: [],
      errors: [{ label: definition.label, message: result.error }],
      diagnostic: buildDiagnostic(
        definition,
        { attempted: true, credentialSource, ...classifyRuntimeError(result.error), entryCount: 0 },
        auth,
      ),
    };
  }

  return {
    entries: result.entries.map((entry) => ({
      ...entry,
      accounting: { ...entry.accounting, sourceId: definition.id },
    })),
    errors: (result.rowErrors ?? []).map((message) => ({ label: definition.label, message })),
    diagnostic: buildDiagnostic(
      definition,
      { attempted: true, credentialSource, outcome: "success", entryCount: result.entries.length },
      auth,
    ),
  };
}

async function executeLocal(
  definition: LocalEstimateQuotaProviderDefinition,
): Promise<InstanceResult> {
  let entries: QuotaToastEntry[] | null;
  try {
    entries = (await collectLocalQuotaProviderEstimate(definition)).entries;
  } catch {
    entries = null;
  }
  const state = await inspectLocalQuotaProviderState(definition);
  const stateFields = {
    statePath: state.path,
    stateHealth: state.health,
    stateVersion: state.version,
    stateLastUpdatedAt: state.lastUpdatedAt,
  };
  if (!entries) {
    return {
      entries: [],
      errors: [{ label: definition.label, message: "Failed to update local accounting state" }],
      diagnostic: {
        ...buildDiagnostic(definition, {
          attempted: true,
          credentialSource: null,
          outcome: "local_state_error",
          entryCount: 0,
        }),
        ...stateFields,
      },
    };
  }
  return {
    entries,
    errors: [],
    diagnostic: {
      ...buildDiagnostic(definition, {
        attempted: true,
        credentialSource: null,
        outcome: "success",
        entryCount: entries.length,
      }),
      ...stateFields,
    },
  };
}

export const quotaProvidersProvider: QuotaProvider = {
  id: QUOTA_PROVIDERS_AGGREGATE_ID,

  async isAvailable(ctx): Promise<boolean> {
    if (customQuotaProviderDefinitions(ctx.config.quotaProviders ?? []).length === 0) return false;
    return selectDefinitions(ctx, await ctx.resolveRuntimeProviderIds()).length > 0;
  },

  matchesCurrentModel(model, context): boolean {
    const identity = resolveQuotaProviderSessionModelIdentity({
      currentModel: model,
      currentProviderID: context?.currentProviderID,
    });
    if (!identity) return false;
    return customQuotaProviderDefinitions(context?.quotaProviders ?? []).some(
      (definition) =>
        definition.providerId === identity.providerId &&
        (definition.modelIds === undefined || definition.modelIds.includes(identity.modelId)),
    );
  },

  async fetch(ctx, cacheContext): Promise<QuotaProviderResult> {
    if (customQuotaProviderDefinitions(ctx.config.quotaProviders ?? []).length === 0) {
      return { attempted: false, entries: [], errors: [] };
    }

    let selected = cacheContext?.runtimeEligibleQuotaProviders;
    if (!selected) {
      let availableProviderIds: ReadonlySet<string>;
      try {
        availableProviderIds = await ctx.resolveRuntimeProviderIds();
      } catch {
        return {
          attempted: true,
          entries: [],
          errors: [
            {
              label: "Quota providers",
              message: "Failed to read exact runtime provider identities",
            },
          ],
        };
      }
      selected = selectDefinitions(ctx, availableProviderIds);
    }
    if (selected.length === 0) {
      return { attempted: false, entries: [], errors: [] };
    }

    const results = await mapWithConcurrency(
      selected,
      DEFINITION_CONCURRENCY,
      async (definition): Promise<InstanceResult> => {
        try {
          return definition.mode === "remote-api"
            ? await executeRemote(definition, ctx.config.requestTimeoutMs)
            : await executeLocal(definition);
        } catch {
          return {
            entries: [],
            errors: [{ label: definition.label, message: "Provider execution failed" }],
            diagnostic: buildDiagnostic(definition, {
              attempted: true,
              credentialSource: null,
              outcome: "network_error",
              entryCount: 0,
            }),
          };
        }
      },
    );

    return {
      attempted: true,
      entries: results.flatMap((result) => result.entries),
      errors: results.flatMap((result) => result.errors),
      diagnostics: results.map((result) => result.diagnostic),
    };
  },
};
