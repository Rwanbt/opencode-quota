import { describe, expect, it } from "vitest";

import { publicDetail, safeDebugValue, safeDetail } from "../src/core/redact.js";

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

const HOME = "/Users/alice";
const WINDOWS_HOME = "C:\\Users\\Alice Smith";

describe("publicDetail", () => {
  it.each([
    {
      name: "a cookie header with spaces around a pair",
      text: "HTTP 401 Cookie: sid = CANARYsid; theme=dark",
      shown: "HTTP 401 Cookie: [redacted]",
    },
    {
      name: "a cookie header with a quoted pair",
      text: 'Cookie: theme=dark; sid="CANARY sid" | next',
      shown: "Cookie: [redacted] | next",
    },
    {
      name: "a cookie header with a bare pipe or brace in a value",
      text: "Cookie: sid=a|CANARY; b=a}CANARY",
      shown: "Cookie: [redacted]",
    },
    {
      name: "an escaped quote in a JSON password",
      text: String.raw`{"password":"a\"CANARY"}`,
      shown: '{"password":[redacted]}',
    },
    {
      name: "a bracket inside an array of account ids",
      text: '{"accountIds":["id]CANARY","id2"],"plan":"pro"}',
      shown: '{"accountIds":[id],"plan":"pro"}',
    },
    {
      name: "names written with JSON unicode escapes",
      text: String.raw`{"account\u0049d":"CANARY1","\u0070assword":"CANARY2"}`,
      shown: '{"accountId":[id],"password":[redacted]}',
    },
    {
      name: "a JSON-escaped terminal escape inside the home dir",
      text: String.raw`path=/Users/al\u001b[0mice/.config/x`,
      shown: "path=~/.config/x",
      hidden: ["alice"],
    },
    {
      name: "a raw terminal escape inside the home dir",
      text: "path=/Users/al\u001b[31mice/.config/x",
      shown: "path=~/.config/x",
      hidden: ["alice"],
    },
    {
      name: "a long text cut inside the home dir",
      text: `${"x".repeat(20)} /Users/alice/.config`,
      max: 32,
      shown: `${"x".repeat(20)} ~/.config`,
      hidden: ["/Users"],
    },
    {
      name: "a Windows device path to the home dir",
      home: WINDOWS_HOME,
      text: "bin=\\\\?\\C:\\Users\\Alice Smith\\x and \\\\.\\C:\\Users\\Alice Smith\\y",
      shown: "bin=~\\x and ~\\y",
      hidden: ["Alice"],
    },
    {
      name: "a long model id with capitalised words and numbers",
      text: "unpriced: Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 and deepseek-ai/DeepSeek-R1-Distill-Qwen-32B-Preview",
      shown:
        "unpriced: Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 and deepseek-ai/DeepSeek-R1-Distill-Qwen-32B-Preview",
    },
    {
      name: "a cookie in JSON, the other fields kept",
      text: '{"cookie":"a=CANARY; b=2","status":401}',
      shown: '{"cookie":[redacted],"status":401}',
    },
    {
      name: "an API key in escaped JSON",
      text: '{\\"api_key\\":\\"CANARYkey\\",\\"plan\\":\\"pro\\"}',
      shown: '{\\"api_key\\":[redacted],\\"plan\\":\\"pro\\"}',
    },
    {
      name: "a user id in escaped JSON",
      text: '{\\"user_id\\":\\"CANARYuser\\"}',
      shown: '{\\"user_id\\":[id]}',
    },
    {
      name: "a whole array of user ids",
      text: '"user_ids": ["CANARY1", "CANARY2"], "plan": "pro"',
      shown: '"user_ids": [id], "plan": "pro"',
    },
    {
      name: "a percent-encoded email address in a query",
      text: "GET /v1/usage?email=alice.CANARY%40example.com&plan=pro",
      shown: "GET /v1/usage?email=[email]&plan=pro",
    },
    {
      name: "an email address and short account ids",
      text: "alice.CANARY@example.co.uk account_id=CANARY1 teamId: CANARY2",
      shown: "[email] account_id=[id] teamId: [id]",
    },
    {
      name: "a bearer token and a key shape",
      text: "Authorization: Bearer CANARYtoken | sk-proj-CANARYsecret0123",
      shown: "Authorization: [redacted] | [redacted]",
    },
    {
      name: "a long opaque token and a UUID",
      text: "token CANARY0abcdefghijklmnopqrstuvwxyz0123 / 123e4567-e89b-12d3-a456-426614174000",
      shown: "token [redacted] / [redacted]",
      hidden: ["426614174000"],
    },
    {
      name: "a Windows home with forward slashes",
      home: WINDOWS_HOME,
      text: "binary=C:/Users/Alice Smith/.local/bin/claude.exe",
      shown: "binary=~/.local/bin/claude.exe",
      hidden: ["Alice"],
    },
    {
      name: "a Windows home in another letter case with mixed slashes",
      home: WINDOWS_HOME,
      text: "path=c:\\users/alice smith\\bin",
      shown: "path=~\\bin",
      hidden: ["alice"],
    },
    {
      name: "a JSON-escaped Windows home",
      home: WINDOWS_HOME,
      text: JSON.stringify("C:\\Users\\Alice Smith\\bin"),
      shown: '"~\\\\bin"',
      hidden: ["Alice"],
    },
    {
      name: "a Windows home with repeated spaces",
      home: "C:\\Users\\Alice  Smith",
      text: "path=C:\\Users\\Alice  Smith\\bin",
      shown: "path=~\\bin",
      hidden: ["Alice"],
    },
    {
      name: "a folder that only starts like the Windows home",
      home: WINDOWS_HOME,
      text: "path=C:\\Users\\Alice Smithson\\bin",
      shown: "path=C:\\Users\\Alice Smithson\\bin",
    },
    {
      name: "a model id with many words",
      text: "unpriced: google/gemini-2.0-flash-preview-image-generation",
      shown: "unpriced: google/gemini-2.0-flash-preview-image-generation",
    },
    {
      name: "a diagnostic name made from a provider id",
      text: "custom_production-gateway-us_check outcome=success",
      shown: "custom_production-gateway-us_check outcome=success",
    },
  ] as Array<{
    name: string;
    text: string;
    home?: string;
    max?: number;
    shown: string;
    hidden?: string[];
  }>)("hides what a public issue must not show: $name", ({
    text,
    home = HOME,
    max = Infinity,
    shown,
    hidden = [],
  }) => {
    const result = publicDetail(text, max, home);

    expect(result).toBe(shown);
    for (const part of ["CANARY", ...hidden]) expect(result).not.toContain(part);
  });
});
