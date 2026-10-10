/**
 * The plugin RPC between OpenCode Quota's server plugin and its clients. The server
 * registers it in its setup and computes quota there; clients call it by this definition.
 * Imports from `@opencode/*` and `./core/*` stay type-only, so loading this file loads no
 * OpenCode package and no server code.
 *
 * v6 methods: `snapshot` (the last known quota, instantly) and `refresh`, plus the `changed`
 * event with every new snapshot, and `usage` (tokens and cost from OpenCode's history for one
 * range). The v5 methods `surface`, `footer`, `writeExport` and `command` stay until the v6
 * TUI replaces them.
 */
import type { Rpc } from "@opencode/plugin";
import type { QuotaSnapshot } from "./core/types.js";
import type { UsageQuery, UsageRange, UsageReport } from "./core/usage.js";
import { parseCalendarDate } from "./lib/calendar-date.js";
import {
  isQuotaDialogCommand,
  type QuotaDialogCommandId,
  type QuotaDialogCommandOutputResult,
} from "./lib/quota-dialog-command-specs.js";

export const QUOTA_RPC_ID = "slkiser.opencode-quota";

export type QuotaRpcSurfaceInput = {
  surface: "sidebar" | "idle" | "compacted" | "question";
  sessionID: string;
};
export type QuotaRpcSurfaceOutput = {
  quota: {
    message: string;
    duration: number;
    activeProviderCount: number;
    resetNotification?: string;
  } | null;
};
export type QuotaRpcFooterInput = { surface: "prompt" | "home"; sessionID?: string };
export type QuotaRpcFooterOutput = { lines: string[] };
export type QuotaRpcWriteExportInput = Record<string, never>;
export type QuotaRpcWriteExportOutput = { written: boolean };
export type QuotaRpcCommandInput = {
  command: QuotaDialogCommandId;
  arguments?: string;
  sessionID?: string;
};
export type QuotaRpcCommandOutput = QuotaDialogCommandOutputResult;
export type QuotaRpcSnapshotInput = { sessionID?: string };
export type QuotaRpcRefreshReason = "poll" | "turn" | "manual";
export type QuotaRpcRefreshInput = {
  reason: QuotaRpcRefreshReason;
  providerIds?: string[];
  sessionID?: string;
};
/** Answer of `snapshot` and `refresh`, and the data of the `changed` event. */
export type QuotaRpcSnapshotOutput = { snapshot: QuotaSnapshot };
export type QuotaRpcUsageInput = UsageQuery;
export type QuotaRpcUsageOutput = { report: UsageReport };

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

function checkSnapshotOutput(value: unknown): string | null {
  return isObject(value) && isObject(value.snapshot) ? null : "output must carry a snapshot";
}

const SURFACES = ["sidebar", "idle", "compacted", "question"];
const FOOTER_SURFACES = ["prompt", "home"];
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
    surface: {
      input: schema<QuotaRpcSurfaceInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (typeof value.surface !== "string" || !SURFACES.includes(value.surface)) {
          return `surface must be one of ${SURFACES.join(", ")}`;
        }
        if (typeof value.sessionID !== "string") return "sessionID must be a string";
        return null;
      }),
      output: schema<QuotaRpcSurfaceOutput>(checkOutput),
    },
    footer: {
      input: schema<QuotaRpcFooterInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (typeof value.surface !== "string" || !FOOTER_SURFACES.includes(value.surface)) {
          return `surface must be one of ${FOOTER_SURFACES.join(", ")}`;
        }
        return checkOptionalString(value, "sessionID");
      }),
      output: schema<QuotaRpcFooterOutput>(checkOutput),
    },
    writeExport: {
      input: schema<QuotaRpcWriteExportInput>((value) =>
        isObject(value) ? null : "input must be an object",
      ),
      output: schema<QuotaRpcWriteExportOutput>(checkOutput),
    },
    command: {
      input: schema<QuotaRpcCommandInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (typeof value.command !== "string" || !isQuotaDialogCommand(value.command)) {
          return "command must be a quota command id";
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
        const ids = value.providerIds;
        if (
          ids !== undefined &&
          !(Array.isArray(ids) && ids.every((id) => typeof id === "string"))
        ) {
          return "providerIds must be a list of strings";
        }
        return checkOptionalString(value, "sessionID");
      }),
      output: schema<QuotaRpcSnapshotOutput>(checkSnapshotOutput),
    },
    usage: {
      input: schema<QuotaRpcUsageInput>(checkUsageInput),
      output: schema<QuotaRpcUsageOutput>((value) =>
        isObject(value) && isObject(value.report) ? null : "output must carry a report",
      ),
    },
  },
} satisfies Rpc.PortableDefinition;
