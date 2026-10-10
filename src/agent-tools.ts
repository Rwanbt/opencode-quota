/**
 * Tools for AI agents: read the server settings, change the provider, checking and pricing
 * settings, and add, test and remove custom providers. Words, notices, export and telemetry
 * are the user's (in /quota → Customize); looks are not server settings at all. Every write
 * holds the settings lock and goes into OpenCode Quota's own settings file, never opencode.json.
 *
 * Keys: a provider added by an agent is saved switched off (`"enabled": false`), so nothing
 * reads its key or fetches it until the user switches it on in /quota_settings → Providers. No
 * tool switches a provider on. Every answer is cleaned in one place: each key the plugin can
 * read, and anything in a known key format, is replaced before the agent sees it.
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
  describeQuotaProviderRequest,
  QUOTA_PROVIDERS_AGGREGATE_ID,
  type QuotaProviderDefinition,
} from "./lib/quota-providers.js";
import { collectLocalQuotaProviderEstimate } from "./lib/quota-providers-local.js";
import {
  fetchRemoteQuotaProvider,
  resolveQuotaProviderApiKey,
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

/** Replaces every key in one string; see `credentialRedactor`. */
type Redact = (text: string) => string;

const REDACTED = "[redacted]";

/** The top-level settings agents may change; the user changes the others in /quota → Customize. */
const AGENT_GROUPS: readonly string[] = ["providers", "checking", "pricing"];

const TOP_LEVEL_SETTINGS: ReadonlySet<string> = new Set(
  Object.keys(SETTINGS_SCHEMA).map((key) => key.split(".")[0]),
);

const DEFINITION_SECRET_MESSAGE =
  "looks like a key or other secret, so nothing was saved. Put the key in an environment " +
  "variable and set apiKeyEnv to its name, or leave apiKeyEnv out to use OpenCode's key.";

const SWITCH_ON = "Ask the user to switch it on in /quota_settings → Providers";

const SETTING_SECRET_MESSAGE = "looks like a key or other secret, so nothing was saved";

/** A top-level definition field that would hold a secret; `apiKeyEnv` holds only a name. */
const SECRET_FIELD_PATTERN = /key|token|secret|passw|bearer|cookie|credential|authorization/i;

/** Known key formats, found anywhere in a text: refused in inputs, replaced in answers. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic, OpenRouter, DeepSeek, Moonshot
  /\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /\b1\/\/[0-9A-Za-z_-]{20,}/g, // Google OAuth refresh token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, // JWT, all three parts
  /\bbearer\s+\S{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

/** Fields holding names (ids, model names, URLs, JSON paths): long runs pass in them. */
const NAME_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "providerId",
  "modelIds",
  "url",
  "path",
  "rowsPath",
  "pricingModelMap",
]);

/** The validator's rule for an environment variable name, the only thing apiKeyEnv holds. */
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Environment variables whose values the answers never show: the names keys go by. */
const KEY_VARIABLE_NAME = /API_?KEY|TOKEN|SECRET|PASSW|COOKIE|CREDENTIAL/i;

/** Keys this long are replaced anywhere; shorter ones only as a whole token, so no word is cut. */
const LONG_KEY_LENGTH = 8;

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
 * True when a value holds something shaped like a key: a known key format, a random run of
 * letters and digits, or (outside name fields) any run of 24+ of them. Any other character ends
 * a run, so model names such as "Qwen3-Coder-480B-A35B-Instruct-2507", UUIDs and version
 * strings pass. A heuristic: keys never belong in a definition or a setting, only in an
 * environment variable.
 */
function looksSecret(text: string, isName: boolean): boolean {
  return (
    SECRET_PATTERNS.some((pattern) => text.search(pattern) !== -1) ||
    (text.match(/[A-Za-z0-9]{20,}/g) ?? []).some(
      (run) => looksRandom(run) || (!isName && run.length >= 24),
    )
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
function secretIssues(
  value: unknown,
  key: string,
  message: string,
  isName = false,
): SettingsIssue[] {
  if (typeof value === "string") return looksSecret(value, isName) ? [{ key, message }] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => secretIssues(item, `${key}[${index}]`, message, isName));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([name, item]) =>
      secretIssues(item, key ? `${key}.${name}` : name, message, isName || NAME_FIELDS.has(name)),
    );
  }
  return [];
}

/**
 * A field named like a secret is refused whatever it holds; other fields by their values. A
 * valid variable name in apiKeyEnv is only a name (the key rule checks it).
 */
function definitionSecretIssues(definition: Record<string, unknown>): SettingsIssue[] {
  return Object.entries(definition).flatMap(([field, value]): SettingsIssue[] => {
    if (field === "apiKeyEnv" && typeof value === "string" && VARIABLE_NAME.test(value)) return [];
    if (field !== "apiKeyEnv" && SECRET_FIELD_PATTERN.test(field)) {
      return [{ key: `definition.${field}`, message: DEFINITION_SECRET_MESSAGE }];
    }
    return secretIssues(
      value,
      `definition.${field}`,
      DEFINITION_SECRET_MESSAGE,
      NAME_FIELDS.has(field),
    );
  });
}

/**
 * Every key the plugin can read: variables named like keys or named by a custom provider; keys
 * in the global opencode.json(c); and API-key logins saved in OpenCode for the providers
 * OpenCode has. OAuth tokens are not read (that could refresh them); `SECRET_PATTERNS` covers
 * their shape.
 */
async function credentialValues(host: QuotaAgentToolsHost): Promise<string[]> {
  const custom = (await loadSettings()).settings.providers.custom;
  const variables = new Set(
    Object.keys(process.env).filter((name) => KEY_VARIABLE_NAME.test(name)),
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
    typeof value === "string" && value.trim() ? [value.trim()] : [],
  );
}

/**
 * Replaces, in one string, each key the plugin can read and each known key format. A key under
 * LONG_KEY_LENGTH counts only as a whole token (letters, digits, `_` and `-`).
 */
async function credentialRedactor(host: QuotaAgentToolsHost): Promise<Redact> {
  // Longest first, so a key that contains another is replaced whole.
  const values = [...new Set(await credentialValues(host))].sort((a, b) => b.length - a.length);
  const long = values.filter((value) => value.length >= LONG_KEY_LENGTH);
  const short = values
    .filter((value) => value.length < LONG_KEY_LENGTH)
    .map((value) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "g");
    });
  return (text) => {
    let redacted = text;
    for (const value of long) redacted = redacted.split(value).join(REDACTED);
    for (const pattern of short) redacted = redacted.replace(pattern, REDACTED);
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

/**
 * The rows the sidebar would show for a definition's entries, or why there are none. Row ids
 * are made from the names and ids in them, so every string in them is redacted first, to a
 * placeholder a row id may hold.
 */
function testedRows(
  definition: QuotaProviderDefinition,
  entries: QuotaToastEntry[],
  rowErrors: readonly string[],
  redact: Redact,
): ToolResult {
  const result = {
    attempted: true,
    entries,
    errors: rowErrors.map((message) => ({ label: definition.label, message })),
  };
  const fetched = rowsFromLegacyResult(
    QUOTA_PROVIDERS_AGGREGATE_ID,
    redactStrings(result, (text) => redact(text).replaceAll(REDACTED, "redacted")) as typeof result,
  );
  const problems = fetched.debug.map((detail) => detail.value);
  if (fetched.rows.length === 0) {
    return { ok: false, error: "The answer had no rows that could be read.", problems };
  }
  return { ok: true, rows: fetched.rows, ...(problems.length > 0 ? { problems } : {}) };
}

/**
 * One fetch of one switched-on definition now, as the rows the sidebar would show, or why it
 * failed. Its key is read the way the plugin reads it.
 */
async function testFetch(
  definition: QuotaProviderDefinition,
  requestTimeoutMs: number,
  redact: Redact,
): Promise<ToolResult> {
  if (definition.enabled === false) {
    return { ok: false, error: `Not tested: it is switched off. ${SWITCH_ON}, then test it.` };
  }
  if (definition.mode === "local-estimate") {
    return testedRows(
      definition,
      (await collectLocalQuotaProviderEstimate(definition)).entries,
      [],
      redact,
    );
  }
  const { key } = await resolveQuotaProviderApiKey(definition);
  if (!key) {
    return {
      ok: false,
      error:
        `No API key found. It is read from ${describeQuotaProviderRequest(definition)?.key}. ` +
        "The user saves it there and restarts OpenCode; then run quota_provider_test.",
    };
  }
  const result = await fetchRemoteQuotaProvider(definition, key, requestTimeoutMs);
  if (!result.success) return { ok: false, error: result.error };
  return testedRows(
    definition,
    // Rows are keyed by the definition id, as in the provider's own fetch.
    result.entries.map((entry) => ({
      ...entry,
      accounting: { ...entry.accounting, sourceId: definition.id },
    })),
    result.rowErrors ?? [],
    redact,
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

  // Written as the agent sent it, so the file gets no filled-in defaults; a label that only
  // repeats the id is left out. Always switched off, also when it replaces one that was on.
  const { label, ...withoutLabel } = definition;
  const entry = { ...(label === definition.id ? withoutLabel : definition), enabled: false };
  // The entry alone, so its problems point into it; the save checks the whole list.
  const alone = checkSetting("providers.custom", [entry]);
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

  // What the user checks before switching it on: where the key would go, and from where.
  const request = describeQuotaProviderRequest(added);
  const check = request ? `, after checking that ${request.url} may get ${request.key}` : "";
  const notes = await visibilityNotes(added, (await loadSettings()).settings, host);
  return {
    ok: true,
    [replaced ? "replaced" : "added"]: added.id,
    file: settingsPath(),
    enabled: false,
    ...(request ? { request } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    message:
      `Saved, switched off: nothing reads its key or fetches it yet. ${SWITCH_ON}${check}; ` +
      "then test it with quota_provider_test.",
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
      // Each string is cleaned on its own, so a replacement never reaches the JSON around it.
      return { content: JSON.stringify(redactStrings(result, redact), null, 2) };
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
      "Add a custom OpenCode Quota provider, or replace the one with its id. It is saved " +
        "switched off: the user switches it on in /quota_settings → Providers, then " +
        "quota_provider_test fetches it. No key in the definition: apiKeyEnv names the " +
        "variable holding it; without it, OpenCode's key for providerId is used. Rules: " +
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
      host,
      "quota_provider_test",
      "Fetch one switched-on custom OpenCode Quota provider by id now. Returns the rows or " +
        "the error.",
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
