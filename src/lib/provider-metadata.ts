import {
  type CanonicalQuotaProviderId,
  QUOTA_PROVIDER_REGISTRATION_SOURCE,
  type QuotaProviderAuthentication,
  type QuotaProviderAuthFallback,
  type QuotaProviderAutoSetup,
  type QuotaProviderRegistrationSourceEntry,
} from "./provider-registration.js";

export type { CanonicalQuotaProviderId } from "./provider-registration.js";

export interface QuotaProviderShape {
  id: CanonicalQuotaProviderId;
  recommendedReplacementId?: CanonicalQuotaProviderId;
  autoSetup: QuotaProviderAutoSetup;
  authentication: QuotaProviderAuthentication;
  authFallbacks?: QuotaProviderAuthFallback[];
  quickSetupAnchor?: string;
  notes?: string;
}

export interface QuotaProviderCatalogEntry {
  label: string;
  labelAliases: readonly string[];
  runtimeIds: readonly string[];
  synonyms: readonly string[];
  shape: QuotaProviderShape;
}

const REGISTRATIONS: readonly QuotaProviderRegistrationSourceEntry[] =
  QUOTA_PROVIDER_REGISTRATION_SOURCE;
const CANONICAL_IDS = new Set(REGISTRATIONS.map(({ id }) => id));

function isCanonicalQuotaProviderId(value: string): value is CanonicalQuotaProviderId {
  return CANONICAL_IDS.has(value);
}

function catalogEntry(source: QuotaProviderRegistrationSourceEntry): QuotaProviderCatalogEntry {
  const { recommendedReplacementId, authFallbacks, ...shape } = source.shape;
  if (recommendedReplacementId && !isCanonicalQuotaProviderId(recommendedReplacementId)) {
    throw new Error(`Unknown quota provider replacement: ${recommendedReplacementId}`);
  }
  return {
    label: source.label,
    labelAliases: [...(source.labelAliases ?? [])],
    runtimeIds: [...source.runtimeIds],
    synonyms: [...source.synonyms],
    shape: {
      id: source.id as CanonicalQuotaProviderId,
      ...shape,
      ...(recommendedReplacementId
        ? { recommendedReplacementId: recommendedReplacementId as CanonicalQuotaProviderId }
        : {}),
      ...(authFallbacks ? { authFallbacks: [...authFallbacks] } : {}),
    },
  };
}

/** Every provider in registration order. */
export const QUOTA_PROVIDER_CATALOG = Object.fromEntries(
  REGISTRATIONS.map((source) => [source.id, catalogEntry(source)]),
) as Readonly<Record<CanonicalQuotaProviderId, QuotaProviderCatalogEntry>>;

const CATALOG = Object.entries(QUOTA_PROVIDER_CATALOG) as Array<
  [CanonicalQuotaProviderId, QuotaProviderCatalogEntry]
>;

export const QUOTA_PROVIDER_RUNTIME_IDS = Object.fromEntries(
  CATALOG.map(([id, entry]) => [id, entry.runtimeIds]),
) as Readonly<Record<CanonicalQuotaProviderId, readonly string[]>>;

/** Labels by provider id and by label alias. */
const LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CATALOG.flatMap(([id, entry]) => [id, ...entry.labelAliases].map((name) => [name, entry.label])),
);

const SYNONYMS: Readonly<Record<string, string>> = Object.fromEntries(
  CATALOG.flatMap(([id, entry]) => entry.synonyms.map((synonym) => [synonym, id])),
);

const LIVE_LOCAL_USAGE_IDS = new Set(
  REGISTRATIONS.filter((s) => s.liveLocalUsage).map((s) => s.id),
);

/** Trimmed, lowercase, and a synonym ("claude") turned into its provider id ("anthropic"). */
export function normalizeQuotaProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return SYNONYMS[normalized] ?? normalized;
}

export function getQuotaProviderShape(id: string): QuotaProviderShape | undefined {
  const normalized = normalizeQuotaProviderId(id);
  return isCanonicalQuotaProviderId(normalized)
    ? QUOTA_PROVIDER_CATALOG[normalized].shape
    : undefined;
}

/** The provider's label; an unknown id is shown as given. */
export function getQuotaProviderDisplayLabel(id: string): string {
  return LABELS[normalizeQuotaProviderId(id)] ?? id;
}

/** The OpenCode provider ids that count as this provider (narrower than its synonyms). */
export function getQuotaProviderRuntimeIds(id: string): readonly string[] {
  const shape = getQuotaProviderShape(id);
  return shape ? [...new Set(QUOTA_PROVIDER_RUNTIME_IDS[shape.id])] : [];
}

export function getQuotaProviderIdsForRuntimeId(id: string): readonly CanonicalQuotaProviderId[] {
  const normalized = id.trim().toLowerCase();
  return CATALOG.filter(([, entry]) => entry.runtimeIds.includes(normalized)).map(([id]) => id);
}

export function isLiveLocalUsageProviderId(id: string): boolean {
  return LIVE_LOCAL_USAGE_IDS.has(normalizeQuotaProviderId(id));
}
