/**
 * A faked provider's answer on the row contract, for tests that replace a whole provider.
 * Type-only imports, so a test's module mocks stay in charge of what loads.
 */
import type { QuotaWindow } from "../../src/core/types.js";
import type { ProviderFetchResult, ProviderRow } from "../../src/providers/contract.js";

/** A remote, provider-reported quota row with the percent left. */
export function percentRow(
  key: string,
  label: string,
  percentRemaining: number,
  extra: Partial<ProviderRow> & { window?: QuotaWindow } = {},
): ProviderRow {
  return {
    key,
    label,
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    percentRemaining,
    ...extra,
  };
}

/** A remote, provider-reported row that shows a text, for example "$42". */
export function textRow(key: string, label: string, text: string): ProviderRow {
  return {
    key,
    label,
    type: "usage",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    text,
  };
}

/** One account of an answer: its display name, rows and error messages. */
export type FakeAccount = { name: string; login?: string; rows?: ProviderRow[]; errors?: string[] };

/** An answer from a provider that could ask: each account with its rows and errors. */
export function answer(...accounts: FakeAccount[]): ProviderFetchResult {
  return {
    attempted: true,
    accounts: accounts.map((account) => ({
      name: account.name,
      ...(account.login ? { login: account.login } : {}),
      rows: account.rows ?? [],
      errors: (account.errors ?? []).map((message) => ({ message })),
    })),
    debug: [],
  };
}

/** The answer of a provider that is not set up. */
export const NOT_SET_UP: ProviderFetchResult = { attempted: false, accounts: [], debug: [] };
