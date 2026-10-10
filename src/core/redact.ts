/**
 * Credential redaction for any provider text the store keeps or sends: error details, debug
 * details and logs. Provider errors can echo a request (an Authorization header, a key in the
 * query string, a token in a JSON body), so every such text passes here before it is cut to
 * length, saved or shown.
 */
import { sanitizeSingleLineDisplayText } from "../lib/display-sanitize.js";

const REDACTED = "[redacted]";

/** Names whose value is a secret, in headers, query strings, JSON and `name=value` text. */
const SECRET_NAME =
  "(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|cookie|session[_-]?id|signature|sig)";

/** Checked in order; each replaces what it matches. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization: Bearer abc / "authorization":"Basic abc"
  [/\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)[^"'\n,;}]*/giu, `$1$2${REDACTED}`],
  // Bearer abc, Basic abc (outside a header too)
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu, `$1 ${REDACTED}`],
  // api_key=abc, "apiKey": "abc", x-api-key: abc, ?key=abc&
  [
    new RegExp(`\\b(${SECRET_NAME})(["']?\\s*[:=]\\s*["']?)[^\\s"'&,;}]+`, "giu"),
    `$1$2${REDACTED}`,
  ],
  // Well-known key shapes: sk-..., sk_live_..., ghp_..., github_pat_..., AIza..., xai-...
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/gu, REDACTED],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/gu, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/gu, REDACTED],
  [/\bxai-[A-Za-z0-9]{10,}/gu, REDACTED],
  // JWT-shaped strings and long opaque strings (tokens, session ids)
  [/eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)*/gu, REDACTED],
  [/[A-Za-z0-9_-]{32,}/gu, REDACTED],
];

/** `text` with credential-looking parts replaced by "[redacted]". */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** One safe line: control characters removed, credentials redacted, then cut to `maxLength`. */
export function safeDetail(text: string, maxLength: number): string {
  return redactSecrets(sanitizeSingleLineDisplayText(text)).slice(0, maxLength);
}
