/**
 * OpenCode V2 server plugin: quota slash commands for Web and Desktop, a diagnostics tool, and
 * the quota RPC that serves the quota snapshot, the notices and the reports to the TUI. It reads
 * the server settings (settings.jsonc, converted from v5 once) and follows every change to them.
 * It also writes the export file and the OpenTelemetry gauges from each snapshot. Inside
 * OpenCode, logins are read only here, through OpenCode's integration API.
 */
import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin";
import { quotaAgentTools } from "./agent-tools.js";
import { snapshotFilePath } from "./core/persist.js";
import {
  loadProviderSource,
  loadServerSettings,
  type ProviderSourceHost,
} from "./core/provider-source.js";
import { createSnapshotPublisher } from "./core/snapshot-publisher.js";
import { createQuotaStore } from "./core/store.js";
import type { QuotaSnapshot, SessionModel } from "./core/types.js";
import { type UsageQuery, type UsageReport, usageReport } from "./core/usage.js";
import { resolveOpenCodeLocationRoots } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { homeNoticeLine, listNotices, markNotices } from "./lib/maintainer-home-notice.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
  scrubCredentialErrorText,
} from "./lib/opencode-auth.js";
import { reconcileDetectedProvidersInGlobalConfig } from "./lib/opencode-config-providers.js";
import {
  applyPricingSettings,
  buildQuotaDialogCommandOutput,
  kickPricingRefresh,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-commands.js";
import { QUOTA_PROVIDERS_AGGREGATE_ID } from "./lib/quota-providers.js";
import {
  containsQuotaReport,
  formatQuotaReportMessage,
  QUOTA_REPORT_METADATA_KEY,
  type QuotaReportMetadata,
  quotaMessageText,
  removeQuotaReports,
} from "./lib/quota-report-message.js";
import { resolveQuotaResetRetryDelayMs } from "./lib/quota-retry-wait.js";
import { messageDocument } from "./lib/report-document.js";
import { fetchSessionTokensForDisplay } from "./lib/session-tokens.js";
import { QuotaRpc, type QuotaRpcCommandOutput, REPORT_COMMANDS } from "./rpc.js";
import {
  acknowledgeDisplayImport,
  convertV5,
  type LoadedSettings,
  loadSettings,
  type PendingDisplayImport,
  pendingDisplayImport,
  saveSettings,
  type V5Conversion,
  watchSettings,
} from "./settings/index.js";
import { DEFAULT_QUICK_LOOK_RANGE } from "./view/quick-look.js";

type ModelMessage = {
  readonly role: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string | null }>;
};

type ModelMessagePart = ModelMessage["content"][number];

function hasQuotaReportText(part: ModelMessagePart): boolean {
  return part.type === "text" && typeof part.text === "string" && containsQuotaReport(part.text);
}

/**
 * Drops quota report messages, found by their metadata, and cuts reports out of the text of
 * the remaining user messages. The cut covers compaction checkpoints, which hold copied
 * message text without its metadata, and title requests, which get plain text only.
 */
function withoutQuotaReports<M extends ModelMessage>(messages: M[]): M[] {
  return messages.flatMap((message): M[] => {
    if (message.role !== "user") return [message];
    if (message.metadata?.[QUOTA_REPORT_METADATA_KEY] !== undefined) return [];
    if (!message.content.some(hasQuotaReportText)) return [message];
    const content = message.content.map((part) =>
      hasQuotaReportText(part) ? { ...part, text: removeQuotaReports(part.text as string) } : part,
    );
    return [{ ...message, content }];
  });
}

/** An error as one line that is safe to log: tokens redacted, at most 120 characters. */
function logReason(error: unknown): string {
  return scrubCredentialErrorText(error instanceof Error ? error.message : String(error));
}

/**
 * Runs an RPC handler and logs its failure in the OpenCode service before rethrowing it.
 * The client gets only OpenCode's `rpc.internal` error, so the reason shows only here.
 */
async function logRpcFailure<T>(method: string, handler: () => Promise<T>): Promise<T> {
  try {
    return await handler();
  } catch (error) {
    console.warn(`[opencode-quota] ${method} RPC failed: ${logReason(error)}`);
    throw error;
  }
}

/**
 * The settings (or one part of them) with the keys of that part the file sets, so a value set
 * to its default in the file still differs from no value. The keys are sorted: their order in
 * the file changes nothing.
 */
function settingsWithSources(loaded: LoadedSettings, part?: "checking" | "pricing"): string {
  const fromFile = loaded.fromFile
    .filter((key) => part === undefined || key.startsWith(`${part}.`))
    .sort();
  return JSON.stringify([part === undefined ? loaded.settings : loaded.settings[part], fromFile]);
}

/** Writes the v5 settings into settings.jsonc once; a failure leaves them converted in memory. */
async function convertV5Settings(): Promise<V5Conversion | undefined> {
  try {
    return await convertV5();
  } catch (error) {
    console.warn(`[opencode-quota] settings conversion failed: ${logReason(error)}`);
    return undefined;
  }
}

export const QuotaToastPlugin = Plugin.define({
  id: "@slkiser/opencode-quota.server",
  async setup(ctx) {
    const roots = resolveOpenCodeLocationRoots(ctx.location.directory);
    const projectDir = roots.workspaceRoot;
    // The providers ask OpenCode which providers it has through this small client.
    const client = {
      config: {
        providers: async () => ({
          data: {
            providers: (await ctx.provider.list()).data.map((provider) => ({ id: provider.id })),
          },
        }),
      },
    };

    // The v5 settings move into settings.jsonc before anything reads the settings. The server
    // holds the settings it read last; every reader takes them from here.
    const conversion = await convertV5Settings();
    let loaded: LoadedSettings = await loadSettings({ projectDir });
    // Local estimates use prices, so the price list is chosen before any check.
    applyPricingSettings(loaded.settings.pricing);
    // The v5 looks the conversion found, sent with every snapshot until a TUI applied them and
    // acknowledged their id. Empty looks still tell the TUI that the settings were converted.
    let displayImport: PendingDisplayImport | undefined =
      (await pendingDisplayImport()) ??
      (conversion?.written ? { id: randomUUID(), display: {} } : undefined);
    /** The looks a TUI acknowledged; a file read before that never offers them again. */
    const acknowledgedImportIds = new Set<string>();

    // In auto mode, /quota_status reports the providers it detected. The slash commands and
    // the tool add them to the global OpenCode config; the TUI palette (via RPC) never writes it.
    const buildOutput = (
      command: QuotaDialogCommandId,
      sessionID: string | undefined,
      argumentsText: string | undefined,
      options: { reconcileDetectedProviders: boolean },
    ) =>
      buildQuotaDialogCommandOutput({
        command,
        arguments: argumentsText,
        host: sourceHost,
        sessionID,
        resolveSessionModel: sessionModel,
        conversion,
        onDetectedProviderIds: options.reconcileDetectedProviders
          ? async (providerIds) => {
              if (providerIds.length === 0) return;
              try {
                await reconcileDetectedProvidersInGlobalConfig({
                  configRootDir: roots.configRoot,
                  detectedProviderIds: providerIds,
                });
              } catch (error) {
                console.warn("Failed to add detected providers to global OpenCode config", error);
              }
            }
          : undefined,
      });

    // The v6 quota store: last known rows, saved in the state dir, refreshed in the background.
    // Building it reads nothing; the first snapshot or refresh call loads the file.
    const sourceHost: ProviderSourceHost = {
      client,
      workspaceRoot: roots.workspaceRoot,
      settings: () => loaded,
    };
    const store = createQuotaStore({
      source: () => loadProviderSource(sourceHost),
      file: snapshotFilePath(),
    });
    // The TUI reads the session model from its local store, which has nothing for an
    // unknown session. The RPC handlers match that: a failed lookup means no model.
    // With a session, a snapshot also names the providers serving its current model.
    const sessionModel = async (sessionID: string | undefined): Promise<SessionModel> => {
      if (!sessionID) return {};
      try {
        const session = await ctx.session.get({ sessionID });
        return { id: session.model?.id, providerID: session.model?.providerID };
      } catch {
        return {};
      }
    };
    // With a session, a snapshot also has the tokens the session used so far.
    const withSessionTokens = async (
      snapshot: QuotaSnapshot,
      sessionID: string | undefined,
    ): Promise<QuotaSnapshot> => {
      if (!sessionID) return snapshot;
      const { sessionTokens } = await fetchSessionTokensForDisplay({
        enabled: true,
        sessionID,
        scope: loaded.settings.words.sessionTokens,
      });
      if (!sessionTokens) return snapshot;
      return {
        ...snapshot,
        sessionTokens: {
          input: sessionTokens.totalInput,
          cachedInput: sessionTokens.totalCachedInput ?? 0,
          output: sessionTokens.totalOutput,
        },
      };
    };
    // Every snapshot a client gets carries the server's words, the OpenCode provider of each
    // custom definition, and the v5 looks still to apply, and none of the export parts the
    // server keeps for the export file.
    const forClients = (snapshot: QuotaSnapshot): QuotaSnapshot => {
      const custom = loaded.settings.providers.custom;
      return {
        ...snapshot,
        providers: snapshot.providers.map(({ exportPart: _serverOnly, ...provider }) => provider),
        words: loaded.settings.words,
        ...(custom.length > 0
          ? {
              customRowProviders: Object.fromEntries(
                custom.map((one) => [
                  `${QUOTA_PROVIDERS_AGGREGATE_ID}.custom.${one.id}.`,
                  one.providerId,
                ]),
              ),
            }
          : {}),
        ...(displayImport ? { displayImport } : {}),
      };
    };

    // A notice can target the users of some providers: the enabled and available ones,
    // found without asking any provider for quota.
    const noticeTargets = async () =>
      (await loadProviderSource(sourceHost)).providers.map(({ id }) => id);

    // Tokens and cost from OpenCode's history, with the configured price list. As the token
    // reports do, a due price download gets up to 0.75 s to finish first.
    const loadUsage = async (query: UsageQuery): Promise<UsageReport> => {
      const { pricing } = loaded.settings;
      applyPricingSettings(pricing);
      await kickPricingRefresh({
        reason: "tokens",
        maxWaitMs: 750,
        snapshotSelection: pricing.source,
      });
      return usageReport(query);
    };

    // Awaited so the plugin is active only once the RPC is registered: OpenCode waits for
    // activation before it routes an RPC call, so the first TUI call cannot miss it.
    const registration = await ctx.rpc.register(QuotaRpc, {
      command: async (input): Promise<QuotaRpcCommandOutput> => {
        try {
          return await buildOutput(input.command, input.sessionID, input.arguments, {
            reconcileDetectedProviders: false,
          });
        } catch (error) {
          // Return the reason as output so the TUI shows it instead of OpenCode's rpc.internal.
          const spec = REPORT_COMMANDS.find((item) => item.id === input.command)!;
          const output = sanitizeDisplayText(
            error instanceof Error ? error.message : String(error),
          );
          return {
            state: "output",
            command: input.command,
            title: spec.title,
            output,
            document: messageDocument(output),
          };
        }
      },
      snapshot: (input) =>
        logRpcFailure("snapshot", async () => {
          const snapshot = await store.snapshot({ model: await sessionModel(input.sessionID) });
          return { snapshot: forClients(await withSessionTokens(snapshot, input.sessionID)) };
        }),
      refresh: (input) =>
        logRpcFailure("refresh", async () => {
          const model = await sessionModel(input.sessionID);
          const options = { reason: input.reason, providerIds: input.providerIds, model };
          const snapshot = await store.refresh(options);
          return { snapshot: forClients(await withSessionTokens(snapshot, input.sessionID)) };
        }),
      notices: () =>
        logRpcFailure("notices", async () => {
          const { enabled, home, homeFrequency } = loaded.settings.announcements;
          if (!enabled || !home) return { homeLine: "" };
          return {
            homeLine: await homeNoticeLine({
              frequency: homeFrequency,
              providerIds: await noticeTargets(),
            }),
          };
        }),
      // The notice switches are settings: saved to settings.jsonc and in use before the answer.
      noticeList: (input) =>
        logRpcFailure("noticeList", async () => {
          const patch = {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.home === undefined ? {} : { home: input.home }),
          };
          if (Object.keys(patch).length > 0) {
            const saved = await saveSettings({ announcements: patch }, { allowFileOnly: false });
            if (!saved.ok) {
              const reasons = saved.issues.map((issue) => `${issue.key}: ${issue.message}`);
              throw new Error(`cannot save the notice settings (${reasons.join("; ")})`);
            }
            await applySettings(await loadSettings({ projectDir }));
          }
          if (input.read?.length) await markNotices(input.read, true);
          if (input.unread?.length) await markNotices(input.unread, false);
          const { enabled, home } = loaded.settings.announcements;
          const notices = enabled ? await listNotices({ providerIds: await noticeTargets() }) : [];
          return { enabled, home, notices };
        }),
      status: (input) =>
        logRpcFailure("status", async () => {
          const result = await buildOutput("quota_status", input.sessionID, undefined, {
            reconcileDetectedProviders: false,
          });
          return {
            text:
              result.state === "output"
                ? sanitizeDisplayText(result.output)
                : "OpenCode Quota is turned off in its settings.",
          };
        }),
      usage: (input) =>
        logRpcFailure("usage", async () => {
          const { range, sessionID, from, to } = input;
          return { report: await loadUsage({ range, sessionID, from, to }) };
        }),
      // The watch sees the save too; reading the file now answers with the new settings in use.
      saveSettings: (input) =>
        logRpcFailure("saveSettings", async () => {
          const result = await saveSettings(input.patch, { allowFileOnly: false });
          if (result.ok) await applySettings(await loadSettings({ projectDir }));
          return { ok: result.ok, issues: result.issues };
        }),
      acknowledgeDisplayImport: (input) =>
        logRpcFailure("acknowledgeDisplayImport", async () => {
          if (displayImport?.id === input.id) {
            acknowledgedImportIds.add(input.id);
            displayImport = undefined;
          }
          await acknowledgeDisplayImport(input.id);
          return {};
        }),
    });
    // The export file and the gauges follow the snapshot; neither asks a provider again.
    const publisher = createSnapshotPublisher({
      loadSettings: () => loadServerSettings(sourceHost),
      log: (message, error) => console.warn(`[opencode-quota] ${message}: ${logReason(error)}`),
    });
    const announce = (snapshot: QuotaSnapshot) => {
      publisher.publish(snapshot);
      void (async () => {
        try {
          await registration.events.emit("changed", { snapshot: forClients(snapshot) });
        } catch (error) {
          console.warn(`[opencode-quota] changed event failed: ${logReason(error)}`);
        }
      })();
    };
    const unsubscribeStore = store.subscribe(announce);

    /** Every client gets a snapshot now: the words and the v5 looks travel with it. */
    const announceNow = () => {
      store.snapshot({ refresh: false }).then(announce, (error) => {
        console.warn(
          `[opencode-quota] snapshot after a settings change failed: ${logReason(error)}`,
        );
      });
    };
    /** Offers the v5 looks a save kept since the start (it finished the conversion). */
    async function adoptPendingDisplayImport(): Promise<boolean> {
      const pending = await pendingDisplayImport();
      if (!pending || pending.id === displayImport?.id) return false;
      if (acknowledgedImportIds.has(pending.id)) return false;
      displayImport = pending;
      return true;
    }
    // New settings can change the providers, who each one is signed in as, the words and the
    // prices. They supersede the store's running work: every client gets a snapshot built from
    // them at once, then the new rows as more `changed` events. A check made with another time
    // limit, interval or price list is out of date, so every provider is checked again.
    async function applySettings(next: LoadedSettings): Promise<void> {
      const previous = loaded;
      loaded = next;
      applyPricingSettings(next.settings.pricing);
      if (settingsWithSources(next) !== settingsWithSources(previous)) {
        const recheck =
          settingsWithSources(next, "checking") !== settingsWithSources(previous, "checking") ||
          settingsWithSources(next, "pricing") !== settingsWithSources(previous, "pricing");
        store.settingsChanged({ recheck });
      }
      if (await adoptPendingDisplayImport()) announceNow();
    }
    // settings.jsonc edited by hand, by an agent or by another OpenCode process. A change made
    // while this setup ran is read once more right after the watch starts.
    const settingsWatch = await watchSettings((next) => void applySettings(next), { projectDir });
    await applySettings(await loadSettings({ projectDir }));

    await ctx.tool.transform((editor) => {
      // Agent tools: read and change the settings file, add, test and remove custom providers.
      const host = {
        openCodeProviderIds: async () => (await ctx.provider.list()).data.map(({ id }) => id),
      };
      for (const tool of quotaAgentTools(host)) editor.add(tool);
      editor.add({
        name: "quota_status",
        description: "Diagnostics for toast, TUI, pricing and local storage.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute(_input, context) {
          const result = await buildOutput("quota_status", context.sessionID, undefined, {
            reconcileDetectedProviders: true,
          });
          return { content: result.state === "output" ? sanitizeDisplayText(result.output) : "" };
        },
      });
    });

    // Web and Desktop list these in their "/" menu and get the report as a chat message. The
    // TUI shows /quota, /quota_status and the other reports itself; only its "chat" form of the
    // /quota quick look runs /quota here.
    const postReport = async (sessionID: string, command: string, report: string) => {
      // A message admitted while the AI works is delivered into that turn at its next
      // step, and can make the AI take one more step. Wait until the session is idle.
      await ctx.session.wait({ sessionID });
      const metadata: QuotaReportMetadata = { command, at: Date.now() };
      // The report is posted as the user's message. resume: false admits it without
      // starting a model turn, so it waits in the session inbox, where Web and Desktop
      // show it. "steer" delivers it together with the user's next message; "queue"
      // would later give it a model turn of its own.
      await ctx.session.prompt({
        sessionID,
        text: formatQuotaReportMessage(sanitizeDisplayText(report)),
        metadata: { [QUOTA_REPORT_METADATA_KEY]: metadata },
        delivery: "steer",
        resume: false,
      });
    };
    await ctx.command.transform((editor) => {
      editor.add({
        name: "quota",
        description: "Quick look: your quota limits and the last 7 days of usage.",
        async execute(invocation) {
          // /quota waits for the providers that are due a check; the rest show their last rows.
          const model = await sessionModel(invocation.sessionID);
          const snapshot = forClients(await store.refresh({ reason: "poll", model }));
          // Without OpenCode's history the limits still show.
          const usage = await loadUsage({ range: DEFAULT_QUICK_LOOK_RANGE }).catch((error) => {
            console.warn(`[opencode-quota] /quota usage failed: ${logReason(error)}`);
            return undefined;
          });
          const notices = loaded.settings.announcements.enabled
            ? await listNotices({ providerIds: await noticeTargets() })
            : [];
          const report = quotaMessageText({ snapshot, usage, notices, nowMs: Date.now() });
          await postReport(invocation.sessionID, "quota", report);
        },
      });
      const reports = [
        {
          id: "quota_status",
          description: "Diagnostics for quota, TUI, pricing, and local storage.",
        },
        ...REPORT_COMMANDS,
      ] as const;
      for (const spec of reports) {
        editor.add({
          name: spec.id,
          description: spec.description,
          async execute(invocation) {
            const result = await buildOutput(
              spec.id,
              invocation.sessionID,
              invocation.prompt.text.trim() || undefined,
              { reconcileDetectedProviders: true },
            );
            if (result.state === "noop") return;
            await postReport(invocation.sessionID, spec.id, result.output);
          },
        });
      }
    });

    // Keep quota reports out of every model request built from session history:
    // normal turns, compaction summaries, and generate requests.
    for (const hook of ["context", "compaction", "generate"] as const) {
      await ctx.session.hook(hook, (event) => {
        event.messages = withoutQuotaReports(event.messages);
      });
    }
    // OpenCode titles a new session from its first user message, which can be a report.
    // With nothing else to title from, skip the title request and keep the default title.
    await ctx.session.hook("title", (event) => {
      if (!event.messages.some((message) => message.content.some(hasQuotaReportText))) return;
      event.messages = withoutQuotaReports(event.messages);
      const textLeft = event.messages.some((message) =>
        message.content.some((part) => part.type === "text" && part.text.trim() !== ""),
      );
      if (!textLeft) event.result = "";
    });
    // With waitForQuotaReset on, a request that hit a provider limit is retried after the
    // used-up quota window resets. Any failure keeps OpenCode's own retry decision.
    await ctx.session.hook("retry", async (event) => {
      try {
        const delay = await resolveQuotaResetRetryDelayMs(
          { store, loadSettings: () => loadServerSettings(sourceHost) },
          event,
        );
        if (delay !== undefined) event.decision = { retry: true, delay };
      } catch (error) {
        console.warn(`[opencode-quota] retry hook failed: ${logReason(error)}`);
      }
    });

    // Every login read in this process goes through this location's `ctx.integration`. Bound
    // last, so a setup that fails part way leaves no binding behind. OpenCode routes tools,
    // commands and RPC calls to the plugin only after setup, so no read comes earlier.
    const unbindCredentialSource = bindCredentialSource(
      createIntegrationCredentialSource(ctx.integration),
    );
    // A login added, changed or switched in OpenCode drops cached logins and failed-login
    // entries, so the next read asks OpenCode again, and makes the store check who each
    // provider is signed in as. If the subscription fails, cached logins stay until they
    // expire; the log says why. The cleanup's abort ends it silently.
    const credentialEvents = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: credentialEvents.signal })) {
        if (event.type === "credential.updated" || event.type === "credential.switched") {
          notifyCredentialsChanged();
          store.invalidateIdentity();
        }
      }
    })().catch((error) => {
      if (credentialEvents.signal.aborted) return;
      console.warn(`[opencode-quota] credential event subscription stopped: ${logReason(error)}`);
    });

    // Running fetches still read logins, so the store is drained before the binding goes.
    return async () => {
      credentialEvents.abort();
      settingsWatch.close();
      unsubscribeStore();
      publisher.dispose();
      await store.dispose();
      unbindCredentialSource();
    };
  },
});

export default QuotaToastPlugin;
