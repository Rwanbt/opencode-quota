/**
 * Credential redaction for any provider text the store keeps or sends: error details, debug
 * details and logs. Provider errors can echo a request (an Authorization header, a key in the
 * query string, a token in a JSON body), so every such text passes here before it is cut to
 * length, saved or shown.
 */
import { sanitizeSingleLineDisplayText } from "../lib/display-sanitize.js";

const REDACTED = "[redacted]";

/** Words that make a field name secret wherever they stand in it: "session_id", "x-api-key". */
const SECRET_WORDS = new Set([
  "token",
  "key",
  "apikey",
  "secret",
  "password",
  "passwd",
  "pwd",
  "cookie",
  "cookies",
  "session",
  "sessionid",
  "authorization",
  "credential",
  "credentials",
  "signature",
  "sig",
  "jwt",
  "bearer",
]);

/**
 * True when a word of a field name is a secret word. Names split on anything but letters and
 * digits and on camelCase: "access_token", "apiKey", "XSRFToken", "Set-Cookie", "session_id".
 */
export function namesSecret(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .some((word) => SECRET_WORDS.has(word));
}

/**
 * A field value: quoted to its closing quote (escaped quotes and spaces included; also with
 * escaped quotes around it, as in JSON inside JSON), or one unquoted word.
 */
const VALUE = String.raw`(?:\\"(?:[^\\]|\\(?!"))*(?:\\")?|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s"'&,;}]+)`;

/** `name: value`, `name=value`, `"name":"value"` (also `\"name\":\"value\"`). */
const NAMED_VALUE = String.raw`\b([A-Za-z_][\w-]{0,63})(\\?["']?\s*[:=]\s*)${VALUE}`;

/** The value of every pair whose name names a secret; other values are searched as well. */
function redactNamedValues(text: string): string {
  const pattern = new RegExp(NAMED_VALUE, "gu");
  let result = "";
  let copied = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [whole, name = "", separator = ""] = match;
    const valueAt = match.index + name.length + separator.length;
    if (namesSecret(name)) {
      result += `${text.slice(copied, valueAt)}${REDACTED}`;
      copied = match.index + whole.length;
    } else {
      // The value may hold pairs of its own: {"error":"bad api_key=abc"}.
      pattern.lastIndex = valueAt;
    }
  }
  return result + text.slice(copied);
}

/** Checked in order; each replaces what it matches. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Cookie, Set-Cookie and Authorization headers: the whole value, to the end of the line.
  [
    /\b((?:set-)?cookie|(?:proxy-)?authorization)(\\?["']?\s*[:=]\s*)[^\r\n]*/giu,
    `$1$2${REDACTED}`,
  ],
  // Bearer abc, Basic abc (outside a header too)
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu, `$1 ${REDACTED}`],
];

/** Well-known key shapes, JWT-shaped strings and long opaque strings; after named values. */
const SHAPE_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/gu,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/gu,
  /\bAIza[0-9A-Za-z_-]{20,}/gu,
  /\bxai-[A-Za-z0-9]{10,}/gu,
  /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)*/gu,
  /[A-Za-z0-9_-]{32,}/gu,
];

/** `text` with credential-looking parts replaced by "[redacted]". */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  result = redactNamedValues(result);
  for (const pattern of SHAPE_PATTERNS) result = result.replace(pattern, REDACTED);
  return result;
}

/** One safe line: control characters removed, credentials redacted, then cut to `maxLength`. */
export function safeDetail(text: string, maxLength: number): string {
  return redactSecrets(sanitizeSingleLineDisplayText(text)).slice(0, maxLength);
}

/** A debug detail's value made safe; fully redacted when its key names a secret. */
export function safeDebugValue(key: string, value: string, maxLength: number): string {
  return namesSecret(key) ? REDACTED : safeDetail(value, maxLength);
}
