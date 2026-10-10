/**
 * The plugin RPC between OpenCode Quota's server plugin and its clients. The server
 * registers it in its setup and computes quota there; clients call it by this definition.
 * Imports from `@opencode/*` and `./core/*` stay type-only, so loading this file loads no
 * OpenCode package and no server code.
 *
 * Methods: `snapshot` (the last known quota, instantly), `refresh`, `notices` (the Home
 * notice line), `noticeList` (the maintainer notices with their read state), `status` (the
 * /quota_status report), `usage` (tokens and cost from OpenCode's history for one range),
 * `command` (the token and pricing reports), `saveSettings` (a patch of the server settings
 * file) and `acknowledgeDisplayImport` (a TUI applied the snapshot's `displayImport`); the
 * `changed` event carries every new snapshot.
 */
import type { Rpc } from "@opencode/plugin";
import type { QuotaSnapshot } from "./core/types.js";
import type { UsageQuery, UsageRange, UsageReport } from "./core/usage.js";
import { parseCalendarDate } from "./lib/calendar-date.js";
import type { ReportDocument } from "./lib/report-document.js";
import type { SettingsIssue } from "./settings/index.js";

export const QUOTA_RPC_ID = "slkiser.opencode-quota";

/**
 * The report commands of the `command` method. The TUI opens their report in a dialog; Web
 * and Desktop get it as a chat message. `title` is the dialog's title.
 */
export const REPORT_COMMANDS = [
  {
    id: "pricing_refresh",
    title: "OpenCode Quota Pricing Refresh",
    description: "Refresh the local runtime pricing snapshot from models.dev.",
  },
  {
    id: "tokens_today",
    title: "Tokens used (Today)",
    description: "Token + deterministic cost summary for today (calendar day, local timezone).",
  },
  {
    id: "tokens_daily",
    title: "Tokens used (Last 24 Hours)",
    description: "Token + deterministic cost summary for the last 24 hours (rolling).",
  },
  {
    id: "tokens_weekly",
    title: "Tokens used (Last 7 Days)",
    description: "Token + deterministic cost summary for the last 7 days (rolling).",
  },
  {
    id: "tokens_monthly",
    title: "Tokens used (Last 30 Days)",
    description: "Token + deterministic cost summary for the last 30 days (rolling).",
  },
  {
    id: "tokens_all",
    title: "Tokens used (All Time)",
    description: "Token + deterministic cost summary for all locally saved OpenCode history.",
  },
  {
    id: "tokens_session",
    title: "Tokens used (Current Session)",
    description: "Token + deterministic cost summary for current session only.",
  },
  {
    id: "tokens_session_all",
    title: "Tokens used (Current Session Tree)",
    description:
      "Token + deterministic cost summary for current session and all descendant child/subagent sessions.",
  },
  {
    id: "tokens_between",
    title: "OpenCode Quota Token Report",
    description:
      "Token + deterministic cost report between two YYYY-MM-DD dates (local timezone, inclusive).",
  },
] as const;

export type ReportCommandId = (typeof REPORT_COMMANDS)[number]["id"];

export function isReportCommand(command: string): command is ReportCommandId {
  return REPORT_COMMANDS.some((spec) => spec.id === command);
}

export type QuotaRpcCommandInput = {
  command: ReportCommandId;
  arguments?: string;
  sessionID?: string;
};
export type QuotaRpcCommandOutput =
  | {
      state: "output";
      command: string;
      title: string;
      /** The report as text, for the chat, the quota_status tool, and the CLI. */
      output: string;
      /** The same report, structured; the TUI dialog renders it. */
      document: ReportDocument;
    }
  | { state: "noop"; command: string; reason: "disabled" };
export type QuotaRpcSnapshotInput = { sessionID?: string };
export type QuotaRpcRefreshReason = "poll" | "turn" | "manual";
export type QuotaRpcRefreshInput = {
  reason: QuotaRpcRefreshReason;
  providerIds?: string[];
  sessionID?: string;
};
/** Answer of `snapshot` and `refresh`, and the data of the `changed` event. */
export type QuotaRpcSnapshotOutput = { snapshot: QuotaSnapshot };
export type QuotaRpcNoticesInput = Record<string, never>;
/** The maintainer notice line for the bottom of Home; "" when there is none to show now. */
export type QuotaRpcNoticesOutput = { homeLine: string };
/** The /quota_status report as text; with a session, it also checks that session's model. */
export type QuotaRpcStatusInput = { sessionID?: string };
export type QuotaRpcStatusOutput = { text: string };
export type Notice = { id: string; message: string; url?: string; read: boolean };
/** Changes made before the answer: notices marked read or unread, and the two notice settings. */
export type QuotaRpcNoticeListInput = {
  read?: string[];
  unread?: string[];
  enabled?: boolean;
  home?: boolean;
};
/** `home`: the bottom of Home counts the unread notices. `notices` is empty while `enabled` is off. */
export type QuotaRpcNoticeListOutput = { enabled: boolean; home: boolean; notices: Notice[] };
export type QuotaRpcUsageInput = UsageQuery;
export type QuotaRpcUsageOutput = { report: UsageReport };
/** A JSON merge patch of settings.jsonc; file-only keys are refused. */
export type QuotaRpcSaveSettingsInput = { patch: Record<string, unknown> };
/** Nothing is saved unless `ok`; `issues` say why. */
export type QuotaRpcSaveSettingsOutput = { ok: boolean; issues: SettingsIssue[] };
/** The `id` of the snapshot's `displayImport` that the TUI applied. */
export type QuotaRpcAcknowledgeInput = { id: string };
export type QuotaRpcAcknowledgeOutput = Record<string, never>;

type StandardValueSchema = Extract<Rpc.PortableValueSchema, { "~standard": unknown }>;
type StandardEventSchema = Extract<Rpc.PortableEventDefinition["schema"], { "~standard": unknown }>;
type Typed<T> = { "~standard": { types?: { input: T; output: T } } };
type QuotaRpcSchema<T> = StandardValueSchema & Typed<T>;
type QuotaRpcEventSchema<T> = StandardEventSchema & Typed<T>;

/**
 * A Standard Schema that runs `check` and passes the value through unchanged. OpenCode
 * validates every input and output with it. `types` only carries T for TypeScript.
 */
function schema<T>(check: (value: unknown) => string | null): QuotaRpcSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "opencode-quota",
      validate: (value) => {
        const issue = check(value);
        return issue ? { issues: [{ message: issue }] } : { value: value as T };
      },
    },
  };
}

/** The same for event data, which OpenCode requires to be an object. */
function eventSchema<T extends Readonly<Record<string, unknown>>>(
  check: (value: unknown) => string | null,
): QuotaRpcEventSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "opencode-quota",
      validate: (value) => {
        const issue = check(value);
        return issue ? { issues: [{ message: issue }] } : { value: value as T };
      },
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkOutput(value: unknown): string | null {
  return isObject(value) ? null : "output must be an object";
}

function checkOptionalString(input: Record<string, unknown>, field: string): string | null {
  return input[field] === undefined || typeof input[field] === "string"
    ? null
    : `${field} must be a string`;
}

function checkOptionalBoolean(input: Record<string, unknown>, field: string): string | null {
  return input[field] === undefined || typeof input[field] === "boolean"
    ? null
    : `${field} must be true or false`;
}

function checkOptionalStringList(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  return value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
    ? null
    : `${field} must be a list of strings`;
}

function checkSnapshotOutput(value: unknown): string | null {
  return isObject(value) && isObject(value.snapshot) ? null : "output must carry a snapshot";
}

const REFRESH_REASONS: readonly QuotaRpcRefreshReason[] = ["poll", "turn", "manual"];
/** What each usage range needs besides itself. */
const USAGE_RANGE_NEEDS: Record<UsageRange, "nothing" | "sessionID" | "dates"> = {
  today: "nothing",
  "7d": "nothing",
  "30d": "nothing",
  "90d": "nothing",
  all: "nothing",
  session: "sessionID",
  session_tree: "sessionID",
  between: "dates",
};

function checkUsageInput(value: unknown): string | null {
  if (!isObject(value)) return "input must be an object";
  const range = value.range;
  if (typeof range !== "string" || !Object.hasOwn(USAGE_RANGE_NEEDS, range)) {
    return `range must be one of ${Object.keys(USAGE_RANGE_NEEDS).join(", ")}`;
  }
  const typeIssue =
    checkOptionalString(value, "sessionID") ??
    checkOptionalString(value, "from") ??
    checkOptionalString(value, "to");
  if (typeIssue) return typeIssue;
  const needs = USAGE_RANGE_NEEDS[range as UsageRange];
  if (needs === "sessionID" && !value.sessionID) return `sessionID is required for range ${range}`;
  if (needs !== "dates") return null;
  for (const field of ["from", "to"]) {
    if (!parseCalendarDate(value[field])) return `${field} must be a date like 2026-01-31`;
  }
  return (value.from as string) > (value.to as string) ? "to must not be before from" : null;
}

export const QuotaRpc = {
  id: QUOTA_RPC_ID,
  events: {
    changed: { schema: eventSchema<QuotaRpcSnapshotOutput>(checkSnapshotOutput) },
  },
  methods: {
    command: {
      input: schema<QuotaRpcCommandInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (typeof value.command !== "string" || !isReportCommand(value.command)) {
          return "command must be a report command id";
        }
        return checkOptionalString(value, "arguments") ?? checkOptionalString(value, "sessionID");
      }),
      output: schema<QuotaRpcCommandOutput>(checkOutput),
    },
    snapshot: {
      input: schema<QuotaRpcSnapshotInput>((value) =>
        isObject(value) ? checkOptionalString(value, "sessionID") : "input must be an object",
      ),
      output: schema<QuotaRpcSnapshotOutput>(checkSnapshotOutput),
    },
    refresh: {
      input: schema<QuotaRpcRefreshInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (!REFRESH_REASONS.includes(value.reason as QuotaRpcRefreshReason)) {
          return `reason must be one of ${REFRESH_REASONS.join(", ")}`;
        }
        return (
          checkOptionalStringList(value, "providerIds") ?? checkOptionalString(value, "sessionID")
        );
      }),
      output: schema<QuotaRpcSnapshotOutput>(checkSnapshotOutput),
    },
    notices: {
      input: schema<QuotaRpcNoticesInput>((value) =>
        isObject(value) ? null : "input must be an object",
      ),
      output: schema<QuotaRpcNoticesOutput>((value) =>
        isObject(value) && typeof value.homeLine === "string"
          ? null
          : "output must carry a homeLine string",
      ),
    },
    noticeList: {
      input: schema<QuotaRpcNoticeListInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        return (
          checkOptionalStringList(value, "read") ??
          checkOptionalStringList(value, "unread") ??
          checkOptionalBoolean(value, "enabled") ??
          checkOptionalBoolean(value, "home")
        );
      }),
      output: schema<QuotaRpcNoticeListOutput>((value) =>
        isObject(value) && Array.isArray(value.notices) ? null : "output must carry notices",
      ),
    },
    status: {
      input: schema<QuotaRpcStatusInput>((value) =>
        isObject(value) ? checkOptionalString(value, "sessionID") : "input must be an object",
      ),
      output: schema<QuotaRpcStatusOutput>((value) =>
        isObject(value) && typeof value.text === "string" ? null : "output must carry a text",
      ),
    },
    usage: {
      input: schema<QuotaRpcUsageInput>(checkUsageInput),
      output: schema<QuotaRpcUsageOutput>((value) =>
        isObject(value) && isObject(value.report) ? null : "output must carry a report",
      ),
    },
    saveSettings: {
      input: schema<QuotaRpcSaveSettingsInput>((value) =>
        isObject(value) && isObject(value.patch) ? null : "input must carry a patch object",
      ),
      output: schema<QuotaRpcSaveSettingsOutput>((value) =>
        isObject(value) && typeof value.ok === "boolean" && Array.isArray(value.issues)
          ? null
          : "output must carry ok and issues",
      ),
    },
    acknowledgeDisplayImport: {
      input: schema<QuotaRpcAcknowledgeInput>((value) =>
        isObject(value) && typeof value.id === "string" ? null : "input must carry an id",
      ),
      output: schema<QuotaRpcAcknowledgeOutput>(checkOutput),
    },
  },
} satisfies Rpc.PortableDefinition;
