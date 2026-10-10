import type { QuotaProviderResult } from "../lib/entries.js";
import {
  type CredentialRow,
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import type { AuthData } from "../lib/types.js";

type ParsedKeyLogin =
  | { state: "none" }
  | { state: "invalid"; error: string }
  | { state: "configured"; apiKey: string };

/**
 * Every stored API-key login of one vendor, each with its display name.
 * A login that cannot be used becomes an error row instead of disappearing.
 */
export async function readKeyLoginRows<TAuth extends ParsedKeyLogin>(params: {
  integrationIds: readonly string[];
  label: string;
  parseAuth: (auth: AuthData) => TAuth;
  /** Narrow the vendor's rows further, for example to drop alias duplicates. */
  selectRows?: (rows: CredentialRow[]) => CredentialRow[];
}): Promise<{
  credentials: Array<{
    row: CredentialRow;
    displayName: string;
    auth: Extract<TAuth, { state: "configured" }>;
  }>;
  invalidErrors: QuotaProviderResult["errors"];
}> {
  const vendorRows = (await readCredentialRows(params.integrationIds, { methods: ["key"] })).filter(
    (row) => params.integrationIds.includes(row.integrationId),
  );
  const rows = params.selectRows ? params.selectRows(vendorRows) : vendorRows;
  const names = formatCredentialDisplayNames(
    params.label,
    rows.map((row) => ({ row, fallbackName: params.label })),
  );
  const displayNamesByRowId = new Map(
    rows.map((row, index) => [row.id, names[index] ?? params.label]),
  );

  const credentials = [];
  const invalidErrors: QuotaProviderResult["errors"] = [];
  for (const row of rows) {
    const displayName = displayNamesByRowId.get(row.id) ?? params.label;
    const auth = params.parseAuth({ [row.integrationId]: credentialRowAuthEntry(row) } as AuthData);
    if (auth.state === "invalid") invalidErrors.push({ label: displayName, message: auth.error });
    if (auth.state === "configured") {
      credentials.push({
        row,
        displayName,
        auth: auth as Extract<TAuth, { state: "configured" }>,
      });
    }
  }
  return { credentials, invalidErrors };
}
