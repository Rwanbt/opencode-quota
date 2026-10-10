/**
 * Tools for AI agents: read the server settings, change the provider, checking and pricing
 * settings, and add, test and remove custom providers. Words, notices, export and telemetry
 * are the user's (in /quota → Customize); looks are not server settings at all. Every write
 * goes through `saveSettings` into OpenCode Quota's own settings file, never opencode.json.
 *
 * Keys: a provider added by an agent reads its key only from a dedicated environment variable.
 * The tools refuse a built-in provider's variable and a key saved in OpenCode, so an agent
 * cannot send a key it was not given to a URL it chose, and no answer contains a key's value.
 */
import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { rowsFromLegacyResult } from "./core/rows.js";
import type { QuotaToastEntry } from "./lib/entries.js";
import { scrubCredentialErrorText } from "./lib/opencode-auth.js";
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

const REDACTED = "[redacted]";

/** The top-level settings agents may change; the user changes the others in /quota → Customize. */
const AGENT_GROUPS: readonly string[] = ["providers", "checking", "pricing"];

const TOP_LEVEL_SETTINGS: ReadonlySet<string> = new Set(
  Object.keys(SETTINGS_SCHEMA).map((key) => key.split(".")[0]),
);

/**
 * Variables that hold a built-in provider's key: the ones quota's own providers read, plus the
 * main model providers'. A provider added by an agent must use a variable of its own.
 */
const BUILT_IN_KEY_VARIABLES: ReadonlySet<string> = new Set([
  "AGY_CLIENT_SECRET",
  "ALIBABA_API_KEY",
  "ALIBABA_CODING_PLAN_API_KEY",
  "ANTHROPIC_API_KEY",
  "CHUTES_API_KEY",
  "CURSOR_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_CLIENT_SECRET",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "KILO_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CN_API_KEY",
  "KIMI_CODE_API_KEY",
  "KIMI_GLOBAL_API_KEY",
  "MIMO_USAGE_COOKIE",
  "MINIMAX_API_KEY",
  "MINIMAX_CHINA_CODING_PLAN_API_KEY",
  "MINIMAX_CODING_PLAN_API_KEY",
  "NANOGPT_API_KEY",
  "NANO_GPT_API_KEY",
  "OLLAMA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "SYNTHETIC_API_KEY",
  "XAI_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_PLAN_API_KEY",
  "ZHIPU_API_KEY",
  "ZHIPU_CODING_PLAN_API_KEY",
]);

const DEFINITION_SECRET_MESSAGE =
  "looks like a key or other secret, so nothing was saved. Put the key in a dedicated " +
  "environment variable and set apiKeyEnv to the variable's name.";

const SETTING_SECRET_MESSAGE = "looks like a key or other secret, so nothing was saved";

/** A top-level definition field that would hold a secret; `apiKeyEnv` holds only a name. */
const SECRET_FIELD_PATTERN = /key|token|secret|passw|bearer|cookie|credential|authorization/i;

/** Known key formats, found anywhere in a text. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic, OpenRouter, DeepSeek, Moonshot
  /\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bbearer\s+\S{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every save these tools make. Agents may also write the settings the /quota window does not
 * show (custom providers, the Claude CLI path).
 */
function saveAsAgent(patch: unknown): Promise<SaveResult> {
  return saveSettings(patch);
}

function entropyBitsPerCharacter(word: string): number {
  const counts = new Map<string, number>();
  for (const character of word) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / word.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

/**
 * An opaque token of 24+ characters: hex with digits and letters, or mixed-case letters with
 * 2+ digits and high entropy (random keys measure 3.9+ bits per character, long identifiers
 * such as "availableBalanceUSD2024total" about 3.75). A heuristic: it misses some keys and
 * flags a rare identifier, which is why keys never belong in a definition in the first place.
 */
function looksOpaque(word: string): boolean {
  if (word.length < 24) return false;
  const digits = word.match(/\d/g)?.length ?? 0;
  if (/^[0-9a-f]+$/i.test(word)) return digits > 0 && digits < word.length;
  return (
    /[a-z]/.test(word) && /[A-Z]/.test(word) && digits >= 2 && entropyBitsPerCharacter(word) >= 3.8
  );
}

/** The text with every part that looks like a key replaced; a heuristic, see `looksOpaque`. */
function redactText(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, REDACTED);
  return redacted.replace(/[A-Za-z0-9+=_-]{24,}/g, (word) => (looksOpaque(word) ? REDACTED : word));
}

function looksSecret(text: string): boolean {
  return redactText(text) !== text;
}

/** A copy of a JSON value with `redact` applied to every string in it. */
function redactStrings(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redactStrings(item, redact)]),
    );
  }
  return value;
}

/** Every string in a value that looks like a secret, by its path; never the value itself. */
function secretIssues(value: unknown, key: string, message: string): SettingsIssue[] {
  if (typeof value === "string") return looksSecret(value) ? [{ key, message }] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => secretIssues(item, `${key}[${index}]`, message));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([name, item]) =>
      secretIssues(item, key ? `${key}.${name}` : name, message),
    );
  }
  return [];
}

function definitionSecretIssues(definition: Record<string, unknown>): SettingsIssue[] {
  return Object.entries(definition).flatMap(([field, value]) =>
    field !== "apiKeyEnv" && SECRET_FIELD_PATTERN.test(field)
      ? [{ key: `definition.${field}`, message: DEFINITION_SECRET_MESSAGE }]
      : secretIssues(value, `definition.${field}`, DEFINITION_SECRET_MESSAGE),
  );
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
    `quota_settings_set changes only ${AGENT_GROUPS.join(", ")}, as nested objects, e.g. ` +
      '{ "checking": { "minIntervalMs": 600000 } }; null resets a key. The user changes the ' +
      "other settings in /quota → Customize.",
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

/** The dotted keys anywhere in a patch, such as "providers.custom". */
function dottedKeys(patch: Record<string, unknown>, path: string): string[] {
  return Object.entries(patch).flatMap(([name, value]) => {
    const key = path ? `${path}.${name}` : name;
    if (name.includes(".")) return [key];
    return isRecord(value) ? dottedKeys(value, key) : [];
  });
}

/** True when a patch would change the custom providers, which only the provider tools do. */
function touchesCustomProviders(patch: Record<string, unknown>): boolean {
  if (!Object.hasOwn(patch, "providers")) return false;
  const providers = patch.providers;
  return providers === null || (isRecord(providers) && Object.hasOwn(providers, "custom"));
}

/** What an agent may not change in a patch; checked before anything is saved. */
function patchIssues(patch: Record<string, unknown>): SettingsIssue[] {
  // Dotted keys first: saveSettings reads "providers.custom" as a key, past every check below.
  const dotted = dottedKeys(patch, "");
  if (dotted.length > 0) {
    return dotted.map((key) => ({
      key,
      message:
        'use nested objects, not dotted keys, e.g. { "checking": { "minIntervalMs": 600000 } }',
    }));
  }
  const issues: SettingsIssue[] = Object.keys(patch)
    .filter((group) => !AGENT_GROUPS.includes(group))
    .map((group) => ({
      key: group,
      message: TOP_LEVEL_SETTINGS.has(group)
        ? `the user changes ${group} in /quota → Customize; agents may change: ${AGENT_GROUPS.join(", ")}`
        : `unknown setting; agents may change: ${AGENT_GROUPS.join(", ")}`,
    }));
  if (touchesCustomProviders(patch)) {
    issues.push({
      key: "providers.custom",
      message:
        "change custom providers with quota_provider_add and quota_provider_remove; " +
        "to reset other provider settings, set each one to null",
    });
  }
  return [...issues, ...secretIssues(patch, "", SETTING_SECRET_MESSAGE)];
}

async function setSettings(input: unknown): Promise<ToolResult> {
  const patch = isRecord(input) ? input.patch : undefined;
  const issues = isRecord(patch)
    ? patchIssues(patch)
    : [{ key: "patch", message: "expected an object of settings" }];
  if (issues.length > 0) return { ok: false, issues, message: "Nothing was saved." };
  const saved = await saveAsAgent(patch);
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "Nothing was saved." };
  return {
    ok: true,
    file: settingsPath(),
    diff: saved.diff,
    message: saved.diff.length > 0 ? "Saved." : "Nothing changed.",
  };
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

/**
 * The variable these tools may read a definition's key from, or why they may not: a dedicated
 * variable only. A built-in provider's variable or a key saved in OpenCode for `providerId`
 * would let an agent send a key it was never given to the definition's URL. Hand-edited
 * definitions keep the normal key order when quota fetches them; these tools never use it.
 */
async function keyVariable(
  definition: RemoteApiQuotaProviderDefinition,
): Promise<{ variable: string } | { refused: SettingsIssue }> {
  const variable = definition.apiKeyEnv;
  if (!variable) {
    return {
      refused: {
        key: "definition.apiKeyEnv",
        message:
          "required for a provider added by an agent: the name of a dedicated environment " +
          "variable that holds its key, e.g. MYVENDOR_API_KEY",
      },
    };
  }
  if (BUILT_IN_KEY_VARIABLES.has(variable)) {
    return {
      refused: {
        key: "definition.apiKeyEnv",
        message:
          `${variable} holds a built-in provider's key; use a dedicated variable for this ` +
          "provider, e.g. MYVENDOR_API_KEY",
      },
    };
  }
  const saved = await resolveQuotaProviderApiKey({ ...definition, apiKeyEnv: undefined });
  if (saved.key) {
    return {
      refused: {
        key: "definition.providerId",
        message:
          `OpenCode has a key saved for provider "${definition.providerId}", which a provider ` +
          "added by an agent may not use; the user adds this one by hand " +
          "(docs/readme/providers.md#custom-providers)",
      },
    };
  }
  return { variable };
}

/** The rows the sidebar would show for a definition's entries, or why there are none. */
function testedRows(
  definition: QuotaProviderDefinition,
  entries: QuotaToastEntry[],
  rowErrors: readonly string[],
): ToolResult {
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

/** One fetch of one definition now, as the rows the sidebar would show, or why it failed. */
async function testFetch(
  definition: QuotaProviderDefinition,
  requestTimeoutMs: number,
): Promise<ToolResult> {
  if (definition.mode === "local-estimate") {
    return testedRows(
      definition,
      (await collectLocalQuotaProviderEstimate(definition)).entries,
      [],
    );
  }
  const allowed = await keyVariable(definition);
  if ("refused" in allowed) {
    return { ok: false, error: `Not tested: ${allowed.refused.key}: ${allowed.refused.message}` };
  }
  const key = process.env[allowed.variable]?.trim();
  if (!key) {
    return {
      ok: false,
      error:
        `No API key: ${allowed.variable} is not set where OpenCode runs. The user sets it and ` +
        "restarts OpenCode; then run quota_provider_test.",
    };
  }
  const result = await fetchRemoteQuotaProvider(definition, key, requestTimeoutMs);
  const tested = result.success
    ? testedRows(
        definition,
        // Rows are keyed by the definition id, as in the provider's own fetch.
        result.entries.map((entry) => ({
          ...entry,
          accounting: { ...entry.accounting, sourceId: definition.id },
        })),
        result.rowErrors ?? [],
      )
    : { ok: false, error: result.error };
  // An endpoint can echo the key back; its exact value and anything token-shaped are cut.
  return redactStrings(tested, (text) =>
    scrubCredentialErrorText(text.split(key).join(REDACTED)),
  ) as ToolResult;
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
  const secrets = definitionSecretIssues(definition);
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
  const added = (checked.value as QuotaProviderDefinition[])[index];
  if (added.mode === "remote-api") {
    const allowed = await keyVariable(added);
    if ("refused" in allowed) {
      return { ok: false, issues: [allowed.refused], message: "Nothing was saved." };
    }
  }
  const saved = await saveAsAgent({ providers: { custom } });
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "Nothing was saved." };

  const test = await testFetch(added, loaded.settings.checking.requestTimeoutMs);
  const notes = await visibilityNotes(added, loaded.settings, host);
  return {
    ok: true,
    [existing === -1 ? "added" : "replaced"]: added.id,
    file: settingsPath(),
    test,
    ...(notes.length > 0 ? { notes } : {}),
    message: test.ok
      ? "Saved and tested."
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
  return { ok: true, removed: id, remaining: writtenIds(custom), message: "Removed." };
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
      // Whatever a file or an endpoint holds, nothing that looks like a key reaches the agent.
      return { content: JSON.stringify(redactStrings(result, redactText), null, 2) };
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
      "Change OpenCode Quota's providers, checking and pricing settings with a JSON merge " +
        "patch of nested objects; null resets a key. Writes only OpenCode Quota's settings file " +
        "(comments kept), never opencode.json. An unknown key or bad value saves nothing and " +
        "lists the valid ones. Returns what changed. The user changes words, notices, export " +
        "and telemetry in /quota → Customize. Custom providers: quota_provider_add and " +
        "quota_provider_remove.",
      {
        patch: {
          type: "object",
          description:
            'Nested settings to change, e.g. { "checking": { "minIntervalMs": 600000 } }.',
        },
      },
      setSettings,
    ),
    tool(
      "quota_provider_add",
      "Add a custom OpenCode Quota provider, or replace the one with the same id, then fetch " +
        "it once and return the rows it read or the error to fix (call again with the same id). " +
        "Never put a key or other secret in the definition: set apiKeyEnv to the NAME of a " +
        "dedicated environment variable that holds the key (e.g. MYVENDOR_API_KEY); a built-in " +
        "provider's variable or a key saved in OpenCode is refused. Rules: " +
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
      "Remove one custom OpenCode Quota provider by id; the others stay.",
      { id: ID_INPUT },
      removeProvider,
    ),
  ];
}
