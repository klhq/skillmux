const PLACEHOLDER = "[REDACTED]";

// Strips userinfo (user:pass@) from URLs unconditionally, since a
// credential-bearing git URL (private-repo PAT auth) is typed by the user
// directly and never resolved from a config `*_env` key, so it can't be
// caught by the config-driven scrub below.
const URL_USERINFO = /:\/\/[^/\s@]*@/g;

function redactUrlCredentials(text: string): string {
  return text.replace(URL_USERINFO, `://${PLACEHOLDER}@`);
}

/**
 * Walks the config tree for every string-valued key ending in `_env`
 * (api_key_env, token_env, auth_token_env, and any future one) and resolves
 * each to its current environment value.
 */
function collectSecretValues(value: unknown): string[] {
  const secrets: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (key.endsWith("_env") && typeof val === "string") {
        const resolved = process.env[val];
        if (resolved) secrets.push(resolved);
      } else {
        visit(val);
      }
    }
  };
  visit(value);
  return secrets;
}

/**
 * Builds a redactor bound to the currently effective config: a pure
 * `(text) => text` closure that scrubs any resolved `*_env` secret value.
 */
export function buildRedactor(config: unknown): (text: string) => string {
  const secrets = collectSecretValues(config);
  return (text: string): string => {
    let result = redactUrlCredentials(text);
    for (const secret of secrets) {
      result = result.split(secret).join(PLACEHOLDER);
    }
    return result;
  };
}
