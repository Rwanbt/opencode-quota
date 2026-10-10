/**
 * Tools for AI agents: read and change the server settings, and add, test and remove custom
 * providers. Settings and providers only; looks (sidebar, status line, toasts) are not here.
 * Every write goes through `saveSettings` into OpenCode Quota's own settings file, never
 * opencode.json, and the server watches that file, so a change applies live.
 */
import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { rowsFromLegacyResult } from "./core/rows.js";
import type { QuotaToastEntry } from "./lib/entries.js";
import {
  QUOTA_PROVIDERS_AGGREGATE_ID,
  type QuotaProviderDefinition,
  type RemoteApiQuotaProviderDefinition,
} from "./lib/quota-providers.js";
import { collectLocalQuotaProviderEstimate } from "./lib/quota-providers-local.js";
import {
  fetchRemoteQuotaProvider,
  resolveQuotaProviderApiKey,
} from "./lib/quota-providers-remote.js";
import {
  checkSetting,
  describeRule,
  type LoadedSettings,
  loadSettings,
  type SaveResult,
  SETTINGS_SCHEMA,
  type Settings,
  type SettingsIssue,
  saveSettings,
  settingsPath,
} from "./settings/index.js";

export type QuotaAgentToolsHost = {
  /** The providers OpenCode serves now; a custom provider shows only when its providerId is one. */
  openCodeProviderIds(): Promise<readonly string[]>;
};

/** A tool as `ctx.tool.transform(editor => editor.add(tool))` takes it. */
export type QuotaAgentTool = {
  name: string;
  description: string;
  input: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
    additionalProperties: false;
  };
  execute(input: unknown): Promise<{ content: string }>;
};

/** What a tool reports back to the agent, as JSON text. */
type ToolResult = Record<string, unknown>;

const APPLIES_LIVE = "Changes apply live: OpenCode Quota watches its settings file.";

const SECRET_MESSAGE =
  "looks like a key or other secret, so nothing was saved. Put the key in an environment " +
  "variable and set apiKeyEnv to the variable's name.";

/** A top-level definition field that would hold a secret; `apiKeyEnv` holds only a name. */
const SECRET_FIELD_PATTERN = /key|token|secret|passw|bearer|cookie|credential|authorization/i;

/** Text that looks like a key or token, wherever it appears in a definition. */
const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI, Anthropic, OpenRouter, DeepSeek, Moonshot
  /\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /\bbearer\s+\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every save these tools make. Agents may also write the settings the /quota window does not
 * show (custom providers, the Claude CLI path, the export path).
 */
function saveAsAgent(patch: unknown): Promise<SaveResult> {
  return saveSettings(patch);
}

function valueAt(settings: Settings, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), settings);
}

/** Where each remote custom provider reads its API key: a variable name, never its value. */
function apiKeySources(definitions: readonly QuotaProviderDefinition[]): ToolResult[] {
  return definitions.flatMap((definition): ToolResult[] => {
    if (definition.mode !== "remote-api") return [];
    if (!definition.apiKeyEnv) {
      return [
        {
          provider: definition.id,
          apiKeyEnv: null,
          readsFrom: `OpenCode's API key for provider "${definition.providerId}"`,
        },
      ];
    }
    return [
      {
        provider: definition.id,
        apiKeyEnv: definition.apiKeyEnv,
        isSet: Boolean(process.env[definition.apiKeyEnv]?.trim()),
      },
    ];
  });
}

async function getSettings(): Promise<ToolResult> {
  const loaded = await loadSettings();
  const fromFile = new Set(loaded.fromFile);
  const settings = Object.fromEntries(
    Object.entries(SETTINGS_SCHEMA).map(([key, rule]) => [
      key,
      {
        value: valueAt(loaded.settings, key),
        from: fromFile.has(key) ? "file" : "default",
        allowed:
          rule.kind === "customProviders"
            ? "custom provider definitions; change them with quota_provider_add and quota_provider_remove"
            : describeRule(rule),
      },
    ]),
  );
  const notes = [
    APPLIES_LIVE,
    'quota_settings_set takes nested objects, e.g. { "words": { "percent": "used" } }; null resets a key.',
    "Looks (sidebar, status line, toasts) are not in this file; these tools do not change them.",
  ];
  if (!loaded.exists && loaded.conversion) {
    notes.push(
      `The file does not exist yet: the values marked "file" come from ${loaded.conversion.sources.join(", ")}. The first change writes the file.`,
    );
  }
  return {
    file: loaded.path,
    fileExists: loaded.exists,
    settings,
    apiKeys: apiKeySources(loaded.settings.providers.custom),
    ...(loaded.issues.length > 0 ? { problemsInFile: loaded.issues } : {}),
    notes,
  };
}

/** True when a patch would change the custom providers, which only the provider tools do. */
function touchesCustomProviders(patch: Record<string, unknown>): boolean {
  if (!Object.hasOwn(patch, "providers")) return false;
  const providers = patch.providers;
  return providers === null || (isRecord(providers) && Object.hasOwn(providers, "custom"));
}

async function setSettings(input: unknown): Promise<ToolResult> {
  const patch = isRecord(input) ? input.patch : undefined;
  if (isRecord(patch) && touchesCustomProviders(patch)) {
    return {
      ok: false,
      issues: [
        {
          key: "providers.custom",
          message:
            "change custom providers with quota_provider_add and quota_provider_remove; " +
            "to reset other provider settings, set each one to null",
        },
      ],
      message: "Nothing was saved.",
    };
  }
  const saved = await saveAsAgent(patch);
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "Nothing was saved." };
  return {
    ok: true,
    file: settingsPath(),
    diff: saved.diff,
    message: saved.diff.length > 0 ? `Saved. ${APPLIES_LIVE}` : "Nothing changed.",
  };
}

/** A long random-looking word: 32+ characters with upper and lower case and 2+ digits. */
function looksRandom(word: string): boolean {
  return (
    word.length >= 32 &&
    /[a-z]/.test(word) &&
    /[A-Z]/.test(word) &&
    (word.match(/\d/g)?.length ?? 0) >= 2
  );
}

function looksSecret(text: string): boolean {
  return (
    SECRET_TEXT_PATTERNS.some((pattern) => pattern.test(text)) ||
    text.split(/[^A-Za-z0-9_+=-]+/).some(looksRandom)
  );
}

/** The places in a definition that hold or look like a secret, by path; never their values. */
function secretIssues(definition: Record<string, unknown>): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  const visit = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      if (looksSecret(value)) issues.push({ key, message: SECRET_MESSAGE });
    } else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) visit(item, `${key}[${index}]`);
    } else if (isRecord(value)) {
      for (const [name, item] of Object.entries(value)) visit(item, `${key}.${name}`);
    }
  };
  for (const [field, value] of Object.entries(definition)) {
    if (field !== "apiKeyEnv" && SECRET_FIELD_PATTERN.test(field)) {
      issues.push({ key: `definition.${field}`, message: SECRET_MESSAGE });
    } else {
      visit(value, `definition.${field}`);
    }
  }
  return issues;
}

/**
 * `providers.custom` as written in the file (or in the v5 file while there is none), not as
 * checked: a save then keeps what the user wrote, and a bad entry stays visible instead of lost.
 */
async function writtenCustomProviders(loaded: LoadedSettings): Promise<unknown[]> {
  if (!loaded.exists) {
    const converted = loaded.conversion?.values["providers.custom"];
    return Array.isArray(converted) ? converted : [];
  }
  const root: unknown = parse(await readFile(loaded.path, "utf8"), [], {
    allowTrailingComma: true,
  });
  const custom = isRecord(root) && isRecord(root.providers) ? root.providers.custom : undefined;
  return Array.isArray(custom) ? custom : [];
}

function writtenIds(written: readonly unknown[]): string[] {
  return written.flatMap((item) =>
    isRecord(item) && typeof item.id === "string" ? [item.id] : [],
  );
}

function notFound(id: unknown, ids: readonly string[]): ToolResult {
  return {
    ok: false,
    message: `No custom provider has the id ${JSON.stringify(id)}.`,
    ids,
  };
}

function missingKeyMessage(definition: RemoteApiQuotaProviderDefinition): string {
  const openCodeKey = `OpenCode has no API key for provider "${definition.providerId}"`;
  return definition.apiKeyEnv
    ? `No API key: ${definition.apiKeyEnv} is not set where OpenCode runs and ${openCodeKey}. ` +
        "The user sets the variable and restarts OpenCode; then run quota_provider_test."
    : `No API key: ${openCodeKey}. Set apiKeyEnv to the name of the environment variable ` +
        "that holds the key.";
}

/** One fetch of one definition now, as the rows the sidebar would show, or why it failed. */
async function testFetch(
  definition: QuotaProviderDefinition,
  requestTimeoutMs: number,
): Promise<ToolResult> {
  let entries: QuotaToastEntry[];
  let rowErrors: string[] = [];
  if (definition.mode === "remote-api") {
    const auth = await resolveQuotaProviderApiKey(definition);
    if (!auth.key) return { ok: false, error: missingKeyMessage(definition) };
    const result = await fetchRemoteQuotaProvider(definition, auth.key, requestTimeoutMs);
    if (!result.success) return { ok: false, error: result.error };
    // Rows are keyed by the definition id, as in the provider's own fetch.
    entries = result.entries.map((entry) => ({
      ...entry,
      accounting: { ...entry.accounting, sourceId: definition.id },
    }));
    rowErrors = result.rowErrors ?? [];
  } else {
    entries = (await collectLocalQuotaProviderEstimate(definition)).entries;
  }
  const fetched = rowsFromLegacyResult(QUOTA_PROVIDERS_AGGREGATE_ID, {
    attempted: true,
    entries,
    errors: rowErrors.map((message) => ({ label: definition.label, message })),
  });
  const problems = fetched.debug.map((detail) => detail.value);
  if (fetched.rows.length === 0) {
    return { ok: false, error: "The answer had no rows that could be read.", problems };
  }
  return { ok: true, rows: fetched.rows, ...(problems.length > 0 ? { problems } : {}) };
}

/** Why a saved definition would still not show, so the agent can fix it. */
async function visibilityNotes(
  definition: QuotaProviderDefinition,
  settings: Settings,
  host: QuotaAgentToolsHost,
): Promise<string[]> {
  const notes: string[] = [];
  const enabled = settings.providers.enabled;
  if (enabled !== "auto" && !enabled.includes("custom")) {
    notes.push(
      'providers.enabled does not list "custom", so custom providers are not shown; add it with quota_settings_set.',
    );
  }
  let openCodeIds: readonly string[] | undefined;
  try {
    openCodeIds = await host.openCodeProviderIds();
  } catch {
    // Without the list, say nothing rather than guess.
  }
  if (openCodeIds && !openCodeIds.includes(definition.providerId)) {
    notes.push(
      `OpenCode has no provider "${definition.providerId}", so this one is not shown. Set ` +
        `providerId to the OpenCode provider it tracks; OpenCode has: ${openCodeIds.join(", ")}.`,
    );
  }
  return notes;
}

async function addProvider(input: unknown, host: QuotaAgentToolsHost): Promise<ToolResult> {
  const definition = isRecord(input) ? input.definition : undefined;
  if (!isRecord(definition)) {
    return {
      ok: false,
      issues: [{ key: "definition", message: "expected an object" }],
      message: "Nothing was saved.",
    };
  }
  const secrets = secretIssues(definition);
  if (secrets.length > 0) return { ok: false, issues: secrets, message: "Nothing was saved." };

  const loaded = await loadSettings();
  const written = await writtenCustomProviders(loaded);
  const existing = written.findIndex((item) => isRecord(item) && item.id === definition.id);
  const index = existing === -1 ? written.length : existing;
  const custom =
    existing === -1
      ? [...written, definition]
      : written.map((item, at) => (at === existing ? definition : item));
  const checked = checkSetting("providers.custom", custom);
  if (checked.issues.length > 0) {
    const own = `providers.custom[${index}]`;
    return {
      ok: false,
      issues: checked.issues.map((issue) => ({
        ...issue,
        key: issue.key.startsWith(own) ? `definition${issue.key.slice(own.length)}` : issue.key,
      })),
      message: "Nothing was saved. Fix the definition and add it again.",
    };
  }
  const saved = await saveAsAgent({ providers: { custom } });
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "Nothing was saved." };

  const added = (checked.value as QuotaProviderDefinition[])[index];
  const test = await testFetch(added, loaded.settings.checking.requestTimeoutMs);
  const notes = await visibilityNotes(added, loaded.settings, host);
  return {
    ok: true,
    [existing === -1 ? "added" : "replaced"]: added.id,
    file: settingsPath(),
    test,
    ...(notes.length > 0 ? { notes } : {}),
    message: test.ok
      ? `Saved and tested. ${APPLIES_LIVE}`
      : "Saved, but the test failed. Fix the definition and call quota_provider_add again " +
        "with the same id, or remove it with quota_provider_remove.",
  };
}

async function testProvider(input: unknown, host: QuotaAgentToolsHost): Promise<ToolResult> {
  const id = isRecord(input) ? input.id : undefined;
  const loaded = await loadSettings();
  const definitions = loaded.settings.providers.custom;
  const definition = definitions.find((item) => item.id === id);
  if (!definition) {
    const problems = loaded.issues.filter((issue) => issue.key.startsWith("providers.custom"));
    return {
      ...notFound(
        id,
        definitions.map((item) => item.id),
      ),
      ...(problems.length > 0 ? { problemsInFile: problems } : {}),
    };
  }
  const test = await testFetch(definition, loaded.settings.checking.requestTimeoutMs);
  const notes = await visibilityNotes(definition, loaded.settings, host);
  return { id: definition.id, ...test, ...(notes.length > 0 ? { notes } : {}) };
}

async function removeProvider(input: unknown): Promise<ToolResult> {
  const id = isRecord(input) ? input.id : undefined;
  const written = await writtenCustomProviders(await loadSettings());
  const custom = written.filter((item) => !(isRecord(item) && item.id === id));
  if (custom.length === written.length) return notFound(id, writtenIds(written));
  const saved = await saveAsAgent({ providers: { custom } });
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "Nothing was removed." };
  return {
    ok: true,
    removed: id,
    remaining: writtenIds(custom),
    message: `Removed. ${APPLIES_LIVE}`,
  };
}

function tool(
  name: string,
  description: string,
  properties: QuotaAgentTool["input"]["properties"],
  run: (input: unknown) => Promise<ToolResult>,
): QuotaAgentTool {
  return {
    name,
    description,
    input: {
      type: "object",
      properties,
      // Every input is required; an empty list is not valid in every JSON Schema draft.
      ...(Object.keys(properties).length > 0 ? { required: Object.keys(properties) } : {}),
      additionalProperties: false,
    },
    async execute(input) {
      let result: ToolResult;
      try {
        result = await run(input);
      } catch (error) {
        // A thrown error would reach the agent as an internal failure without its reason.
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      return { content: JSON.stringify(result, null, 2) };
    },
  };
}

const ID_INPUT = { type: "string", description: "The custom provider's id." };

const DEFINITION_EXAMPLE = JSON.stringify({
  id: "my-gateway-quota",
  providerId: "my-gateway",
  mode: "remote-api",
  url: "https://gateway.example/v1/quota",
  format: "quota-v1",
  apiKeyEnv: "MY_GATEWAY_API_KEY",
});

export function quotaAgentTools(host: QuotaAgentToolsHost): QuotaAgentTool[] {
  return [
    tool(
      "quota_settings_get",
      "Read OpenCode Quota's server settings: each value, whether it comes from the file or the " +
        "default, the values it allows, the file path, and the environment variable names " +
        "custom providers read API keys from (never their values).",
      {},
      () => getSettings(),
    ),
    tool(
      "quota_settings_set",
      "Change OpenCode Quota's server settings with a JSON merge patch; null resets a key. " +
        "Writes only OpenCode Quota's settings file (comments kept), never opencode.json. An " +
        "unknown key or bad value saves nothing and lists the valid ones. Returns what changed; " +
        "changes apply live. Custom providers: use quota_provider_add and quota_provider_remove.",
      {
        patch: {
          type: "object",
          description: 'Nested settings to change, e.g. { "words": { "percent": "used" } }.',
        },
      },
      setSettings,
    ),
    tool(
      "quota_provider_add",
      "Add a custom OpenCode Quota provider, or replace the one with the same id, then fetch " +
        "it once and return the rows it read or the error to fix (call again with the same id). " +
        "Never put a key or other secret in the definition: set apiKeyEnv to the NAME of the " +
        "environment variable that holds the key. Applies live. Rules: " +
        "https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#custom-providers",
      {
        definition: {
          type: "object",
          description: `One custom provider definition, e.g. ${DEFINITION_EXAMPLE}.`,
        },
      },
      (input) => addProvider(input, host),
    ),
    tool(
      "quota_provider_test",
      "Fetch one custom OpenCode Quota provider now and return the rows it read or the error.",
      { id: ID_INPUT },
      (input) => testProvider(input, host),
    ),
    tool(
      "quota_provider_remove",
      "Remove one custom OpenCode Quota provider by id; the others stay. Applies live.",
      { id: ID_INPUT },
      removeProvider,
    ),
  ];
}
