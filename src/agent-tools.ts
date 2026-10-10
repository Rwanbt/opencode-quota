/**
 * Tools for AI agents: read the server settings, change the provider, checking and pricing
 * settings, and add, test and remove custom providers. Words, notices, export and telemetry
 * are the user's (in /quota → Customize); looks are not server settings at all. Every write
 * holds the settings lock and goes into OpenCode Quota's own settings file, never opencode.json.
 *
 * Keys: a provider added by an agent reads its key only from a variable named OPENCODE_QUOTA_…
 * that the user creates for it. That is decided by the name alone, so a refusal says nothing
 * about saved keys. Every answer is cleaned in one place: each key the plugin can read, and
 * anything in a known key format, is replaced before the agent sees it.
 */
import { rowsFromLegacyResult } from "./core/rows.js";
import {
  getGlobalOpencodeConfigCandidatePaths,
  getProviderConfigSettings,
  readConfigCandidate,
} from "./lib/api-key-resolver.js";
import type { QuotaToastEntry } from "./lib/entries.js";
import { resolveEnvTemplate } from "./lib/env-template.js";
import { readCredentialRows } from "./lib/opencode-auth.js";
import {
  QUOTA_PROVIDERS_AGGREGATE_ID,
  type QuotaProviderDefinition,
  type RemoteApiQuotaProviderDefinition,
} from "./lib/quota-providers.js";
import { collectLocalQuotaProviderEstimate } from "./lib/quota-providers-local.js";
import {
  DEDICATED_KEY_VARIABLE_PREFIX,
  fetchRemoteQuotaProvider,
} from "./lib/quota-providers-remote.js";
import {
  checkSetting,
  describeRule,
  editSettings,
  editSettingsFile,
  loadSettings,
  SETTINGS_SCHEMA,
  type Settings,
  type SettingsIssue,
  type SettingsPatch,
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

/** Replaces every key in a text; see `credentialRedactor`. */
type Redact = (text: string) => string;

const REDACTED = "[redacted]";

/** The top-level settings agents may change; the user changes the others in /quota → Customize. */
const AGENT_GROUPS: readonly string[] = ["providers", "checking", "pricing"];

const TOP_LEVEL_SETTINGS: ReadonlySet<string> = new Set(
  Object.keys(SETTINGS_SCHEMA).map((key) => key.split(".")[0]),
);

const DEFINITION_SECRET_MESSAGE =
  "looks like a key or other secret, so nothing was saved. Put the key in an environment " +
  `variable starting with ${DEDICATED_KEY_VARIABLE_PREFIX} and set apiKeyEnv to its name.`;

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

/** Environment variables whose values the answers never show: the names keys go by. */
const KEY_VARIABLE_NAME = /API_?KEY|TOKEN|SECRET|PASSW|COOKIE|CREDENTIAL/i;

/** Shorter values are not replaced: they would cut ordinary words out of answers. */
const MIN_REDACTED_LENGTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when a run of 20+ letters and digits switches between letters, digits and case so often
 * that its pieces average under 3 characters: a random token, not words. A camelCase name such
 * as "AvailableBalanceUSD2024Total" splits into Available|Balance|USD|2024|Total and passes; a
 * hex or base62 key splits into pieces of 1-2 characters.
 */
function looksRandom(run: string): boolean {
  if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) return false;
  const pieces = run.match(/[0-9]+|[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [];
  return run.length / pieces.length < 3;
}

/**
 * True when a value holds something shaped like a key: a known key format, or a random run of
 * letters and digits. Any other character ends a run, so model names such as
 * "Qwen3-Coder-480B-A35B-Instruct-2507", UUIDs and version strings pass. A heuristic: keys
 * never belong in a definition or a setting, only in an environment variable.
 */
function looksSecret(text: string): boolean {
  return (
    SECRET_PATTERNS.some((pattern) => text.search(pattern) !== -1) ||
    (text.match(/[A-Za-z0-9]{20,}/g) ?? []).some(looksRandom)
  );
}

/** A copy of a JSON value with `redact` applied to every string in it. */
function redactStrings(value: unknown, redact: Redact): unknown {
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

/** A field named like a secret is refused whatever it holds; other fields by their values. */
function definitionSecretIssues(definition: Record<string, unknown>): SettingsIssue[] {
  return Object.entries(definition).flatMap(([field, value]) =>
    field !== "apiKeyEnv" && SECRET_FIELD_PATTERN.test(field)
      ? [{ key: `definition.${field}`, message: DEFINITION_SECRET_MESSAGE }]
      : secretIssues(value, `definition.${field}`, DEFINITION_SECRET_MESSAGE),
  );
}

/**
 * Every key the plugin can read: variables named like keys, named by a custom provider or
 * starting with OPENCODE_QUOTA_; keys in the global opencode.json(c); and API-key logins saved
 * in OpenCode for the providers OpenCode has. OAuth tokens are not read (that could refresh
 * them); `SECRET_PATTERNS` covers their shape.
 */
async function credentialValues(host: QuotaAgentToolsHost): Promise<string[]> {
  const custom = (await loadSettings()).settings.providers.custom;
  const variables = new Set(
    Object.keys(process.env).filter(
      (name) => KEY_VARIABLE_NAME.test(name) || name.startsWith(DEDICATED_KEY_VARIABLE_PREFIX),
    ),
  );
  for (const definition of custom) {
    if (definition.mode === "remote-api" && definition.apiKeyEnv) {
      variables.add(definition.apiKeyEnv);
    }
  }
  const values: unknown[] = [...variables].map((name) => process.env[name]);

  for (const candidate of getGlobalOpencodeConfigCandidatePaths()) {
    const config = await readConfigCandidate(candidate);
    if (!isRecord(config)) continue;
    const providerIds = [config.provider, config.providers].flatMap((group) =>
      isRecord(group) ? Object.keys(group) : [],
    );
    for (const providerId of providerIds) {
      const apiKey = getProviderConfigSettings(config, providerId)?.apiKey;
      if (typeof apiKey === "string") values.push(resolveEnvTemplate(apiKey.trim()));
    }
  }

  const providerIds = new Set([
    ...(await host.openCodeProviderIds()),
    ...custom.map((definition) => definition.providerId),
  ]);
  const logins = await readCredentialRows([...providerIds], { methods: ["key"] });
  values.push(...logins.map((row) => row.value.key));

  return values.flatMap((value) =>
    typeof value === "string" && value.trim().length >= MIN_REDACTED_LENGTH ? [value.trim()] : [],
  );
}

/** Replaces each key the plugin can read (also as escaped in JSON) and each known key format. */
async function credentialRedactor(host: QuotaAgentToolsHost): Promise<Redact> {
  const values = await credentialValues(host);
  const forms = [...new Set(values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))]
    // Longest first, so a key that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let redacted = text;
    for (const form of forms) redacted = redacted.split(form).join(REDACTED);
    for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, REDACTED);
    return redacted;
  };
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
  // Dotted keys first: a save reads "providers.custom" as a key, past every check below.
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
  // Agents may also write settings the /quota window does not show, such as the Claude CLI path.
  const saved = await editSettings(() => patch as SettingsPatch, { allowFileOnly: true });
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "Nothing was saved." };
  return {
    ok: true,
    file: settingsPath(),
    diff: saved.diff,
    message: saved.diff.length > 0 ? "Saved." : "Nothing changed.",
  };
}

/** A list with a bad entry loads as empty, so changing it would drop every entry the user has. */
function customProviderIssues(issues: readonly SettingsIssue[]): SettingsIssue[] {
  return issues.filter((issue) => issue.key.startsWith("providers.custom"));
}

function fixFileFirst(problems: SettingsIssue[]): ToolResult {
  return {
    ok: false,
    issues: problems,
    message: `Nothing was changed: fix the custom providers in ${settingsPath()} first.`,
  };
}

function notFound(id: unknown, ids: readonly string[]): ToolResult {
  return {
    ok: false,
    message: `No custom provider has the id ${JSON.stringify(id)}.`,
    ids,
  };
}

/** True when the key comes from a variable made for it: the only kind these tools allow. */
function usesDedicatedVariable(
  definition: RemoteApiQuotaProviderDefinition,
): definition is RemoteApiQuotaProviderDefinition & { apiKeyEnv: string } {
  return definition.apiKeyEnv?.startsWith(DEDICATED_KEY_VARIABLE_PREFIX) === true;
}

function keyVariableRule(id: string): string {
  const name = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const example = `${DEDICATED_KEY_VARIABLE_PREFIX}${name}_API_KEY`;
  return (
    `apiKeyEnv must name an environment variable starting with ${DEDICATED_KEY_VARIABLE_PREFIX} ` +
    `that the user creates just for this provider, e.g. ${example}`
  );
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
  redact: Redact,
): Promise<ToolResult> {
  if (definition.mode === "local-estimate") {
    return testedRows(
      definition,
      (await collectLocalQuotaProviderEstimate(definition)).entries,
      [],
    );
  }
  if (!usesDedicatedVariable(definition)) {
    return { ok: false, error: `Not tested: ${keyVariableRule(definition.id)}.` };
  }
  const key = process.env[definition.apiKeyEnv]?.trim();
  if (!key) {
    return {
      ok: false,
      error:
        `No API key: ${definition.apiKeyEnv} is not set where OpenCode runs. The user creates ` +
        "it with this provider's key and restarts OpenCode; then run quota_provider_test.",
    };
  }
  const result = await fetchRemoteQuotaProvider(definition, key, requestTimeoutMs);
  if (!result.success) return { ok: false, error: result.error };
  // An endpoint can echo the key into a name, and row ids are made from names: redact first.
  const entries = redactStrings(result.entries, redact) as QuotaToastEntry[];
  return testedRows(
    definition,
    // Rows are keyed by the definition id, as in the provider's own fetch.
    entries.map((entry) => ({
      ...entry,
      accounting: { ...entry.accounting, sourceId: definition.id },
    })),
    redactStrings(result.rowErrors ?? [], redact) as string[],
  );
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

async function addProvider(
  input: unknown,
  host: QuotaAgentToolsHost,
  redact: Redact,
): Promise<ToolResult> {
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

  // The definition alone, so its problems point into it; the save checks the whole list.
  const alone = checkSetting("providers.custom", [definition]);
  if (alone.issues.length > 0) {
    return {
      ok: false,
      issues: alone.issues.map((issue) => ({
        ...issue,
        key: issue.key.replace(/^providers\.custom\[0\]/, "definition"),
      })),
      message: "Nothing was saved. Fix the definition and add it again.",
    };
  }
  const added = (alone.value as QuotaProviderDefinition[])[0];
  if (added.mode === "remote-api" && !usesDedicatedVariable(added)) {
    return {
      ok: false,
      issues: [{ key: "definition.apiKeyEnv", message: keyVariableRule(added.id) }],
      message: "Nothing was saved.",
    };
  }

  // Written as the agent sent it, so the file gets no filled-in defaults; a label that only
  // repeats the id is left out.
  const { label, ...withoutLabel } = definition;
  const entry = label === definition.id ? withoutLabel : definition;
  let problems: SettingsIssue[] = [];
  let replaced = false;
  const saved = await editSettingsFile((current, issues) => {
    problems = customProviderIssues(issues);
    if (problems.length > 0) return undefined;
    const at = current.providers.custom.findIndex((item) => item.id === added.id);
    replaced = at !== -1;
    // Only this entry changes (-1 appends), so the others keep their comments.
    return [{ path: ["providers", "custom", at], value: entry }];
  });
  if (problems.length > 0) return fixFileFirst(problems);
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "Nothing was saved." };

  const { settings } = await loadSettings();
  const test = await testFetch(added, settings.checking.requestTimeoutMs, redact);
  const notes = await visibilityNotes(added, settings, host);
  return {
    ok: true,
    [replaced ? "replaced" : "added"]: added.id,
    file: settingsPath(),
    test,
    ...(notes.length > 0 ? { notes } : {}),
    message: test.ok
      ? "Saved and tested."
      : "Saved, but the test failed. Fix the definition and call quota_provider_add again " +
        "with the same id, or remove it with quota_provider_remove.",
  };
}

async function testProvider(
  input: unknown,
  host: QuotaAgentToolsHost,
  redact: Redact,
): Promise<ToolResult> {
  const id = isRecord(input) ? input.id : undefined;
  const loaded = await loadSettings();
  const definitions = loaded.settings.providers.custom;
  const definition = definitions.find((item) => item.id === id);
  if (!definition) {
    const problems = customProviderIssues(loaded.issues);
    return {
      ...notFound(
        id,
        definitions.map((item) => item.id),
      ),
      ...(problems.length > 0 ? { problemsInFile: problems } : {}),
    };
  }
  const test = await testFetch(definition, loaded.settings.checking.requestTimeoutMs, redact);
  const notes = await visibilityNotes(definition, loaded.settings, host);
  return { id: definition.id, ...test, ...(notes.length > 0 ? { notes } : {}) };
}

async function removeProvider(input: unknown): Promise<ToolResult> {
  const id = isRecord(input) ? input.id : undefined;
  let problems: SettingsIssue[] = [];
  let ids: string[] = [];
  let found = false;
  const saved = await editSettingsFile((current, issues) => {
    problems = customProviderIssues(issues);
    if (problems.length > 0) return undefined;
    ids = current.providers.custom.map((item) => item.id);
    const at = typeof id === "string" ? ids.indexOf(id) : -1;
    found = at !== -1;
    // Only this entry goes, so the others keep their comments.
    return found ? [{ path: ["providers", "custom", at], value: undefined }] : undefined;
  });
  if (problems.length > 0) return fixFileFirst(problems);
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "Nothing was removed." };
  if (!found) return notFound(id, ids);
  return {
    ok: true,
    removed: id,
    remaining: ids.filter((item) => item !== id),
    message: "Removed.",
  };
}

function tool(
  host: QuotaAgentToolsHost,
  name: string,
  description: string,
  properties: QuotaAgentTool["input"]["properties"],
  run: (input: unknown, redact: Redact) => Promise<ToolResult>,
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
      let redact: Redact;
      try {
        redact = await credentialRedactor(host);
      } catch {
        const message =
          "Nothing was done: the saved keys to hide from the answer could not be read.";
        return { content: JSON.stringify({ ok: false, message }, null, 2) };
      }
      let result: ToolResult;
      try {
        result = await run(input, redact);
      } catch (error) {
        // A thrown error would reach the agent as an internal failure without its reason.
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      // The one place answers are cleaned: whatever a file or an endpoint holds, no key gets out.
      return { content: redact(JSON.stringify(result, null, 2)) };
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
  apiKeyEnv: `${DEDICATED_KEY_VARIABLE_PREFIX}MY_GATEWAY_API_KEY`,
});

export function quotaAgentTools(host: QuotaAgentToolsHost): QuotaAgentTool[] {
  return [
    tool(
      host,
      "quota_settings_get",
      "Read OpenCode Quota's server settings. Returns each value with its source (file or " +
        "default) and allowed values, the file path, and the variable each custom provider " +
        "reads its key from.",
      {},
      () => getSettings(),
    ),
    tool(
      host,
      "quota_settings_set",
      "Change OpenCode Quota's providers, checking or pricing settings with a merge patch of " +
        "nested objects; null resets a key. Returns what changed, or the problems (nothing " +
        "saved). Custom providers: quota_provider_add and quota_provider_remove.",
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
      host,
      "quota_provider_add",
      "Add a custom OpenCode Quota provider, or replace the one with its id, then fetch it " +
        "once. Returns the rows, or the error to fix (add it again with the same id). No key in " +
        "the definition: apiKeyEnv names a variable starting with " +
        `${DEDICATED_KEY_VARIABLE_PREFIX} that the user creates for it. Rules: ` +
        "https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#custom-providers",
      {
        definition: {
          type: "object",
          description: `One custom provider definition, e.g. ${DEFINITION_EXAMPLE}.`,
        },
      },
      (input, redact) => addProvider(input, host, redact),
    ),
    tool(
      host,
      "quota_provider_test",
      "Fetch one custom OpenCode Quota provider by id now. Returns the rows or the error.",
      { id: ID_INPUT },
      (input, redact) => testProvider(input, host, redact),
    ),
    tool(
      host,
      "quota_provider_remove",
      "Remove one custom OpenCode Quota provider by id. Returns the ids that remain.",
      { id: ID_INPUT },
      removeProvider,
    ),
  ];
}
