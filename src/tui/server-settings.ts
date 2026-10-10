/**
 * The server settings the quota window's Words and Providers tabs edit. They live in the
 * server's settings.jsonc, because Web, Desktop and the CLI print quota too: the window reads
 * them with the `settings` RPC and saves its changes with `saveSettings`, which also switches
 * custom providers on or off. Their lines are in `FIELDS` (`display.ts`), stored as "server".
 */
import { createSignal } from "solid-js";
import type { QuotaSnapshot, Words } from "../core/types.js";
import type {
  QuotaRpcSaveSettingsInput,
  QuotaRpcSaveSettingsOutput,
  QuotaRpcSettingsOutput,
} from "../rpc.js";
import { CHANGED_SINCE_REVIEW } from "../settings/schema.js";

/** `providers.enabled`: "auto" checks every provider quota finds, a list only those. */
export const PROVIDERS_KEY = "providers.enabled";
type Enabled = "auto" | string[];

/** The snapshot's provider ids as `providers.enabled` names them: custom providers are "custom". */
export function foundProviderIds(snapshot: QuotaSnapshot | undefined): string[] {
  return (snapshot?.providers ?? []).map(({ providerId }) =>
    providerId === "quota-providers" ? "custom" : providerId,
  );
}

/** "auto" ticks every provider quota found; a list ticks the ones it names. */
export function isTicked(enabled: Enabled, id: string, found: readonly string[]): boolean {
  return enabled === "auto" ? found.includes(id) : enabled.includes(id);
}

/** The list after ticking `id` on or off; from "auto", the ones it found are the start. */
export function withTick(
  enabled: Enabled,
  ids: readonly string[],
  found: readonly string[],
  id: string,
  on: boolean,
): string[] {
  return ids.filter((other) => (other === id ? on : isTicked(enabled, other, found)));
}

/** Changes by dotted key as the JSON merge patch `saveSettings` takes. */
export function settingsPatch(changes: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split(".");
    let group = patch;
    for (const part of parts.slice(0, -1)) {
      group[part] ??= {};
      group = group[part] as Record<string, unknown>;
    }
    group[parts[parts.length - 1] as string] = value;
  }
  return patch;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One entry of `record` set to `value`, or removed when `value` is the saved one. */
function changed<T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T,
  saved: unknown,
): Record<string, T> {
  const next = { ...record };
  if (same(value, saved)) delete next[key];
  else next[key] = value;
  return next;
}

export type ServerSettingsRpc = {
  settings(): Promise<QuotaRpcSettingsOutput>;
  saveSettings(input: QuotaRpcSaveSettingsInput): Promise<QuotaRpcSaveSettingsOutput>;
};

export type ServerSettings = ReturnType<typeof createServerSettings>;

/** The saved server settings, and this window's changes and custom provider switches on top. */
export function createServerSettings(rpc: ServerSettingsRpc) {
  const [saved, setSaved] = createSignal<QuotaRpcSettingsOutput>();
  const [changes, setChanges] = createSignal<Readonly<Record<string, unknown>>>({});
  const [switches, setSwitches] = createSignal<Readonly<Record<string, boolean>>>({});
  /** Custom providers the server would not switch on: their definition changed since shown. */
  const [changedIds, setChangedIds] = createSignal<readonly string[]>([]);
  const savedValue = (key: string) => saved()?.values[key];
  const savedCustom = (id: string) => saved()?.custom.find((entry) => entry.id === id);
  const value = (key: string): unknown =>
    Object.hasOwn(changes(), key) ? changes()[key] : savedValue(key);
  const customOn = (id: string): boolean => switches()[id] ?? savedCustom(id)?.enabled ?? false;
  const dirty = () => Object.keys(changes()).length + Object.keys(switches()).length > 0;
  return {
    /** Undefined until the first `load` answers. */
    saved,
    value,
    set(key: string, next: unknown): void {
      setChanges((current) => changed(current, key, next, savedValue(key)));
    },
    customOn,
    switchCustom(id: string, on: boolean): void {
      setChangedIds((current) => current.filter((other) => other !== id));
      setSwitches((current) => changed(current, id, on, savedCustom(id)?.enabled));
    },
    changedSinceReview: (id: string): boolean => changedIds().includes(id),
    dirty,
    /** The words this window changed, for the surfaces to show while you edit. */
    draftWords(): Partial<Words> {
      return Object.fromEntries(
        Object.entries(changes())
          .filter(([key]) => key.startsWith("words."))
          .map(([key, value]) => [key.slice("words.".length), value]),
      );
    },
    async load(): Promise<void> {
      setSaved(await rpc.settings());
    },
    /**
     * Sends the changes and switches in one save; nothing is saved when the server refuses any
     * of them, and the error says why. A switch-on carries the fingerprint of the definition
     * shown: one that changed since is reloaded and marked, not switched on. A change made while
     * it saves (one back to the old value too) stays unsaved.
     */
    async save(): Promise<void> {
      if (!dirty()) return;
      const sentChanges = changes();
      const sentSwitches = switches();
      const customEnabled = Object.fromEntries(
        Object.entries(sentSwitches).map(([id, enabled]) => [
          id,
          { enabled, fingerprint: savedCustom(id)?.fingerprint ?? "" },
        ]),
      );
      const result = await rpc.saveSettings({
        patch: settingsPatch(sentChanges),
        ...(Object.keys(customEnabled).length > 0 ? { customEnabled } : {}),
      });
      const changedSince = result.issues
        .filter((issue) => issue.message === CHANGED_SINCE_REVIEW)
        .map((issue) => issue.key.slice("providers.custom.".length));
      if (changedSince.length > 0) {
        setSaved(await rpc.settings());
        setChangedIds(changedSince);
        setSwitches((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => !changedSince.includes(id))),
        );
      }
      if (!result.ok) {
        throw new Error(result.issues.map((issue) => `${issue.key}: ${issue.message}`).join("; "));
      }
      const next = await rpc.settings();
      // What the window shows now, over the settings it read before: kept where it differs.
      const keys = new Set([...Object.keys(sentChanges), ...Object.keys(changes())]);
      const wanted = [...keys].map((key) => [key, value(key)] as const);
      const ids = new Set([...Object.keys(sentSwitches), ...Object.keys(switches())]);
      const wantedOn = [...ids].map((id) => [id, customOn(id)] as const);
      setSaved(next);
      setChanges(Object.fromEntries(wanted.filter(([key, v]) => !same(v, next.values[key]))));
      setSwitches(
        Object.fromEntries(
          wantedOn.filter(([id, on]) => on !== (savedCustom(id)?.enabled ?? false)),
        ),
      );
    },
    discard(): void {
      setChanges({});
      setSwitches({});
      setChangedIds([]);
    },
  };
}
