/**
 * The plugin RPC between OpenCode Quota's server plugin and its clients. The server
 * registers it in its setup and computes quota there; clients call it by this definition.
 * Imports from `@opencode/*` and `./core/*` stay type-only, so loading this file loads no
 * OpenCode package and no server code.
 *
 * Methods: `snapshot` (the last known quota, instantly), `refresh`, `notices` (the Home
 * notice line), and `command` (the report dialogs, until the v6 window replaces them); the
 * `changed` event carries every new snapshot.
 */
import type { Rpc } from "@opencode/plugin";
import type { QuotaSnapshot } from "./core/types.js";
import {
  isQuotaDialogCommand,
  type QuotaDialogCommandId,
  type QuotaDialogCommandOutputResult,
} from "./lib/quota-dialog-command-specs.js";

export const QUOTA_RPC_ID = "slkiser.opencode-quota";

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
export type QuotaRpcNoticesInput = Record<string, never>;
/** The maintainer notice line for the bottom of Home; "" when there is none to show now. */
export type QuotaRpcNoticesOutput = { homeLine: string };

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

const REFRESH_REASONS: readonly QuotaRpcRefreshReason[] = ["poll", "turn", "manual"];

export const QuotaRpc = {
  id: QUOTA_RPC_ID,
  events: {
    changed: { schema: eventSchema<QuotaRpcSnapshotOutput>(checkSnapshotOutput) },
  },
  methods: {
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
  },
} satisfies Rpc.PortableDefinition;
