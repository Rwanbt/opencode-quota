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

  it.each([
    // Any secret word in the key hides the whole value.
    ["session_id", "abc", "[redacted]"],
    ["sessionId", "abc", "[redacted]"],
    ["XSRFToken", "abc", "[redacted]"],
    ["x-api-key", "abc", "[redacted]"],
    ["api_key", "abc", "[redacted]"],
    ["apikey", "abc", "[redacted]"],
    ["Authorization", "abc", "[redacted]"],
    ["client-secret-hint", "abc", "[redacted]"],
    ["passwd", "abc", "[redacted]"],
    ["has_token", "true", "[redacted]"],
    // A fact about a secret stays, with secrets inside it still redacted.
    ["api_key_source", "env", "env"],
    ["token_expires_at", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
    ["apiKeyEnv", "CHUTES_API_KEY", "CHUTES_API_KEY"],
    ["token_present", "true", "true"],
    ["cookie_configured", "yes", "yes"],
    ["token_source", "Bearer sk-live-CANARY0123456789", "Bearer [redacted]"],
    // No secret word: kept.
    ["keys", "3", "3"],
    ["monkey", "plain", "plain"],
    ["sessions_in_db", "12", "12"],
    ["console_auth_state", "configured", "configured"],
    ["tokens_used", "500", "500"],
  ])("debug key %s with %j shows %j", (key, value, shown) => {
    expect(safeDebugValue(key, value, 300)).toBe(shown);
  });
});
