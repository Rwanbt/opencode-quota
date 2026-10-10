import { describe, expect, it } from "vitest";

import { safeDebugValue, safeDetail } from "../src/core/redact.js";

describe("credential redaction", () => {
  it.each([
    ["a quoted cookie and the pairs after it", `HTTP 401 Cookie: session="CANARY"; xsrf=CANARY`],
    ["a whole Set-Cookie header", `"set-cookie": "a=1; Path=/", "x": "token=CANARY"`],
    ["an Authorization header with a comma", `Authorization: Digest a="b", response=CANARY`],
    ["escaped quotes in a JSON password", String.raw`{"password":"a\"b CANARY","user":"bob"}`],
    ["JSON inside JSON", String.raw`{\"client_secret\":\"a b CANARY\"}`],
    ["an escaped single quote", String.raw`password='it\'s CANARY'`],
    ["a secret pair inside another value", `{"error":"bad request: api_key=CANARY"}`],
    ["a session name", "session=CANARY&page=2"],
    ["a compound secret name", "x-session-id: CANARY"],
  ])("redacts %s", (_, text) => {
    expect(safeDetail(text, 300)).not.toContain("CANARY");
    expect(safeDetail(text, 300)).toContain("[redacted]");
  });

  it("keeps what follows a quoted secret and values of plain names", () => {
    expect(safeDetail(String.raw`{"password":"a\"b CANARY","user":"bob"}`, 300)).toBe(
      String.raw`{"password":[redacted],"user":"bob"}`,
    );
    expect(safeDetail("error: invalid_grant, keys: 3", 300)).toBe("error: invalid_grant, keys: 3");
  });

  it("redacts a debug value when any word of its key is a secret word", () => {
    for (const key of [
      "session_id",
      "sessionId",
      "XSRFToken",
      "x-api-key",
      "api_key",
      "apikey",
      "refresh_token_expires_at",
      "Authorization",
      "client-secret-hint",
      "passwd",
    ]) {
      expect(safeDebugValue(key, "CANARY", 300), key).toBe("[redacted]");
    }
    for (const key of ["keys", "monkey", "sessions_in_db", "console_auth_state", "tokens_used"]) {
      expect(safeDebugValue(key, "plain", 300), key).toBe("plain");
    }
  });
});
