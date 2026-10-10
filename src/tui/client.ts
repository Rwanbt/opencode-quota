/**
 * The TUI's quota data: the server's last snapshot, kept in Solid signals so every surface
 * redraws when it changes. It asks the server over the quota RPC (`snapshot` when a surface
 * shows, `refresh` after a turn), applies every `changed` event, and asks again every minute
 * in case an event was missed. Nothing reaches OpenCode until a surface shows or a turn ends.
 */
import { createSignal } from "solid-js";
import type { QuotaSnapshot, SessionTokens } from "../core/types.js";
import {
  QuotaRpc,
  type QuotaRpcAcknowledgeInput,
  type QuotaRpcAcknowledgeOutput,
  type QuotaRpcNoticesInput,
  type QuotaRpcNoticesOutput,
  type QuotaRpcRefreshInput,
  type QuotaRpcRefreshReason,
  type QuotaRpcSnapshotInput,
  type QuotaRpcSnapshotOutput,
} from "../rpc.js";

const POLL_INTERVAL_MS = 60_000;
const RPC_TIMEOUT_MS = 60_000;

type CallOptions = { location: { directory: string }; signal: AbortSignal };

/** The quota RPC as OpenCode's TUI client offers it. */
export type QuotaRpcClient = {
  snapshot(input: QuotaRpcSnapshotInput, options: CallOptions): Promise<QuotaRpcSnapshotOutput>;
  refresh(input: QuotaRpcRefreshInput, options: CallOptions): Promise<QuotaRpcSnapshotOutput>;
  notices(input: QuotaRpcNoticesInput, options: CallOptions): Promise<QuotaRpcNoticesOutput>;
  acknowledgeDisplayImport(
    input: QuotaRpcAcknowledgeInput,
    options: CallOptions,
  ): Promise<QuotaRpcAcknowledgeOutput>;
  events: {
    on(
      name: "changed",
      handler: (event: { data: QuotaRpcSnapshotOutput }) => void,
      options?: { signal?: AbortSignal },
    ): () => void;
  };
};

/** What the client needs from the TUI context. */
export type ClientHost = {
  location?: { directory: string };
  client: { rpc: (definition: typeof QuotaRpc) => QuotaRpcClient };
  data: { location?: { default: () => { directory: string } } };
};

function defaultLocation(host: ClientHost): { directory: string } {
  if (!host.data.location) throw new Error("OpenCode gave the TUI no location");
  return host.data.location.default();
}

/** What a snapshot says only about one session. */
type SessionPart = { currentModelProviderIds?: string[]; sessionTokens?: SessionTokens };

export type QuotaClient = {
  /** The latest snapshot with what is known about `sessionID`; undefined before the first answer. */
  snapshot(sessionID?: string): QuotaSnapshot | undefined;
  /** The Home notice line ("" when there is none). */
  homeLine(): string;
  /** A surface shows `sessionID`: load its part now and on every poll until the returned stop. */
  watch(sessionID?: string): () => void;
  /** Loads the Home notice line now and on every poll until the returned stop. */
  watchHome(): () => void;
  /** Tells the server this TUI applied the snapshot's `displayImport`. */
  acknowledgeDisplayImport(): Promise<void>;
  /** Asks the server to refresh; answers the new snapshot, or undefined when the call failed. */
  refresh(reason: QuotaRpcRefreshReason, sessionID?: string): Promise<QuotaSnapshot | undefined>;
  /**
   * Starts the minute poll and allows the `changed` subscription, made with the first call;
   * the returned function stops both.
   */
  start(): () => void;
};

/** RPC calls reject with a plain `{ type, message }` object, not an Error. */
export function rpcErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

export function reportFailure(error: unknown): void {
  // OpenCode answers rpc.unavailable when no server plugin registered the quota RPC here.
  const hint =
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "rpc.unavailable"
      ? " (OpenCode Quota's server plugin is not loaded for this folder)"
      : "";
  console.warn(`[opencode-quota] failed to load quota: ${rpcErrorMessage(error)}${hint}`);
}

/**
 * @param onSnapshot called with every snapshot the client takes (from any call or event), so
 *   toasts can announce new reset notices.
 */
export function createQuotaClient(
  host: ClientHost,
  onSnapshot: (snapshot: QuotaSnapshot) => void = () => {},
): QuotaClient {
  const [latest, setLatest] = createSignal<QuotaSnapshot>();
  const [sessions, setSessions] = createSignal<Record<string, SessionPart>>({});
  const [homeLine, setHomeLine] = createSignal("");
  /** Sessions on screen, with how many surfaces show each. */
  const watched = new Map<string, number>();
  /** Surfaces on screen without a session (the status line on Home). */
  let globalWatchers = 0;
  let homeWatchers = 0;
  let running = false;
  /** Snapshot calls on their way, by session ("" for none). */
  const loading = new Set<string>();
  /** The `changed` subscription while running, made with the first snapshot call. */
  let events: AbortController | undefined;

  // The RPC client is made per call, so nothing reaches OpenCode during plugin setup.
  const rpc = () => host.client.rpc(QuotaRpc);
  const options = (): CallOptions => ({
    location: host.location ?? defaultLocation(host),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  function apply(snapshot: QuotaSnapshot, sessionID?: string): void {
    const { currentModelProviderIds, sessionTokens, ...shared } = snapshot;
    // An answer that left before a newer event arrived must not undo it.
    const current = latest();
    if (!current || current.generatedAtMs <= shared.generatedAtMs) setLatest(shared);
    if (sessionID) {
      setSessions((all) => ({
        ...all,
        [sessionID]: {
          ...(currentModelProviderIds ? { currentModelProviderIds } : {}),
          ...(sessionTokens ? { sessionTokens } : {}),
        },
      }));
    }
    onSnapshot(snapshot);
  }

  function subscribe(): void {
    if (!running || events) return;
    events = new AbortController();
    try {
      rpc().events.on("changed", (event) => apply(event.data.snapshot), {
        signal: events.signal,
      });
    } catch (error) {
      // The poll still updates every minute.
      reportFailure(error);
    }
  }

  function load(sessionID?: string): void {
    // The sidebar and the status line of one session ask together; one call answers both.
    const key = sessionID ?? "";
    if (loading.has(key)) return;
    loading.add(key);
    subscribe();
    rpc()
      .snapshot(sessionID ? { sessionID } : {}, options())
      .then((output) => apply(output.snapshot, sessionID))
      .catch(reportFailure)
      .finally(() => loading.delete(key));
  }

  function loadHomeLine(): void {
    rpc()
      .notices({}, options())
      .then((output) => setHomeLine(output.homeLine))
      .catch(reportFailure);
  }

  function snapshot(sessionID?: string): QuotaSnapshot | undefined {
    const shared = latest();
    if (!shared) return undefined;
    const part = sessionID ? sessions()[sessionID] : undefined;
    return part ? { ...shared, ...part } : shared;
  }

  function poll(): void {
    if (globalWatchers > 0) load();
    for (const sessionID of watched.keys()) load(sessionID);
    if (homeWatchers > 0) loadHomeLine();
  }

  return {
    snapshot,
    homeLine,

    watch(sessionID) {
      if (!sessionID) {
        globalWatchers += 1;
        load();
        return () => {
          globalWatchers -= 1;
        };
      }
      watched.set(sessionID, (watched.get(sessionID) ?? 0) + 1);
      load(sessionID);
      return () => {
        const count = (watched.get(sessionID) ?? 1) - 1;
        if (count > 0) watched.set(sessionID, count);
        else watched.delete(sessionID);
      };
    },

    watchHome() {
      homeWatchers += 1;
      loadHomeLine();
      return () => {
        homeWatchers -= 1;
      };
    },

    async acknowledgeDisplayImport() {
      await rpc().acknowledgeDisplayImport({}, options());
    },

    async refresh(reason, sessionID) {
      try {
        const input: QuotaRpcRefreshInput = sessionID ? { reason, sessionID } : { reason };
        subscribe();
        const output = await rpc().refresh(input, options());
        apply(output.snapshot, sessionID);
        return snapshot(sessionID);
      } catch (error) {
        reportFailure(error);
        return undefined;
      }
    },

    start() {
      running = true;
      if (watched.size > 0 || globalWatchers > 0) subscribe();
      const timer = setInterval(poll, POLL_INTERVAL_MS);
      return () => {
        running = false;
        events?.abort();
        events = undefined;
        clearInterval(timer);
      };
    },
  };
}
