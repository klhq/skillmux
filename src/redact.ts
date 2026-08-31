const PLACEHOLDER = "[REDACTED]";

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
    let result = text;
    for (const secret of secrets) {
      result = result.split(secret).join(PLACEHOLDER);
    }
    return result;
  };
}
