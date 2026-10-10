/**
 * Which providers and rows a surface shows, in which order and under which names. Pure:
 * every surface (TUI, Web text, CLI) picks its rows here from the snapshot and the display
 * settings.
 */
import type {
  ProviderSnapshot,
  QuotaError,
  QuotaRow,
  QuotaSnapshot,
  QuotaWindow,
  Words,
} from "../core/types.js";

export type Surface = "sidebar" | "collapsed" | "statusLine" | "toast";

/** What one surface shows. Ids not named in an order follow in the snapshot's order. */
export type SurfaceRows = {
  enabled: boolean;
  /** Provider ids and row ids this surface leaves out. */
  hidden: string[];
  providerOrder: string[];
  /** Row ids per provider id. */
  rowOrder: Record<string, string[]>;
};

/** The window a provider shows in the collapsed sidebar and the status line. */
export type WindowChoice = "lowest" | QuotaWindow;

/** The part of the display settings that picks rows. */
export type RowSettings = {
  /** Your names for rows, by row id. */
  labels: Record<string, string>;
  surfaces: Record<Surface, SurfaceRows>;
  /** Preferred window by provider id; "lowest" (the default) shows the row with the least left. */
  window: Record<string, WindowChoice>;
};

export type VisibleRow = { row: QuotaRow; label: string };

/** One provider account on a surface: its title, its rows, and its last error. */
export type Group = {
  /** Provider id, or `${providerId} (account)` when it has several accounts. */
  id: string;
  providerId: string;
  /** "Claude" or "Claude (work)". */
  title: string;
  name: string;
  account?: string;
  rows: VisibleRow[];
  error?: QuotaError;
  /** True before the provider was ever checked. */
  unchecked: boolean;
};

/** `ids` first in the given order, then the rest in their own order. */
function ordered<T>(items: readonly T[], idOf: (item: T) => string, order: readonly string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(idOf(item)) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

/** A provider's rows, one group per account in the order the accounts first appear. */
function groupsOf(provider: ProviderSnapshot, rows: VisibleRow[], hadRows: boolean): Group[] {
  const accounts = [...new Set(provider.rows.map((row) => row.account))];
  if (accounts.length === 0) accounts.push(undefined);
  const several = accounts.length > 1;
  return accounts.flatMap((account): Group[] => {
    const own = rows.filter((item) => item.row.account === account);
    // A provider whose rows are all hidden is left out, unless it has an error to show.
    if (hadRows && own.length === 0 && !provider.error) return [];
    const title = account ? `${provider.label} (${account})` : provider.label;
    return [
      {
        id: several ? `${provider.providerId} (${account ?? ""})` : provider.providerId,
        providerId: provider.providerId,
        title,
        name: provider.label,
        ...(account === undefined ? {} : { account }),
        rows: own,
        ...(provider.error ? { error: provider.error } : {}),
        unchecked: provider.checkedAtMs === undefined && provider.rows.length === 0,
      },
    ];
  });
}

/** The providers and rows `surface` shows, in order, with your row names. */
export function visibleGroups(
  snapshot: QuotaSnapshot,
  settings: RowSettings,
  surface: Surface,
  words: Words,
): Group[] {
  const shown = settings.surfaces[surface];
  const hidden = new Set(shown.hidden);
  const currentModel = words.onlyCurrentModel ? snapshot.currentModelProviderIds : undefined;
  const providers = ordered(
    snapshot.providers,
    (provider) => provider.providerId,
    shown.providerOrder,
  ).filter(
    (provider) =>
      !hidden.has(provider.providerId) &&
      (currentModel === undefined || currentModel.includes(provider.providerId)),
  );
  return providers.flatMap((provider) => {
    const rows = ordered(provider.rows, (row) => row.id, shown.rowOrder[provider.providerId] ?? [])
      .filter((row) => !hidden.has(row.id))
      .filter((row) => words.detail === "detailed" || row.prominence === "primary")
      .map((row) => ({ row, label: settings.labels[row.id] ?? row.label }));
    return groupsOf(provider, rows, provider.rows.length > 0);
  });
}

/**
 * The one row a group shows in the collapsed sidebar and the status line: the preferred
 * window, else the row with the least left, else the first row.
 */
export function pickRow(group: Group, choice: WindowChoice = "lowest"): VisibleRow | undefined {
  const withPercent = group.rows.filter((item) => item.row.percentRemaining !== undefined);
  const preferred = withPercent.find((item) => choice !== "lowest" && item.row.window === choice);
  if (preferred) return preferred;
  const primary = withPercent.filter((item) => item.row.prominence === "primary");
  const candidates = primary.length > 0 ? primary : withPercent;
  const lowest = [...candidates].sort(
    (a, b) => (a.row.percentRemaining as number) - (b.row.percentRemaining as number),
  )[0];
  return lowest ?? group.rows[0];
}
