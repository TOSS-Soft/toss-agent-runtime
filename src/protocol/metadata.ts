import type { JsonValue } from "./json.js";
import type { ValidationIssue } from "./types.js";

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function keyWords(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function isSensitiveKey(key: string): boolean {
  const compact = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (
    compact.includes("authorization") ||
    compact.includes("authority") ||
    compact.includes("accepted") ||
    compact.includes("approved") ||
    compact.includes("credential") ||
    compact.includes("password") ||
    compact.includes("secret") ||
    compact.includes("apikey") ||
    compact.includes("privatekey") ||
    compact.includes("governanceapproval") ||
    compact.includes("token")
  ) {
    return true;
  }
  const words = keyWords(key);
  if (
    words.some((word) =>
      [
        "authorization",
        "authority",
        "accepted",
        "approved",
        "credential",
        "password",
        "secret",
        "token",
      ].includes(word),
    )
  ) {
    return true;
  }
  const wordSet = new Set(words);
  return (
    (wordSet.has("api") && wordSet.has("key")) ||
    (wordSet.has("private") && wordSet.has("key")) ||
    (wordSet.has("governance") && wordSet.has("approval"))
  );
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function sensitiveMetadataIssues(value: JsonValue, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const visit = (candidate: JsonValue, currentPath: string): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (isJsonArray(candidate)) {
      for (const [index, entry] of candidate.entries()) visit(entry, `${currentPath}/${index}`);
      return;
    }
    for (const [key, entry] of Object.entries(candidate)) {
      const entryPath = `${currentPath}/${pointerSegment(key)}`;
      if (isSensitiveKey(key)) {
        issues.push({
          path: entryPath,
          keyword: "sensitiveMetadata",
          message: "secret or governance-authority metadata keys are forbidden",
        });
      }
      visit(entry, entryPath);
    }
  };

  visit(value, basePath);
  return issues.sort((left, right) => left.path.localeCompare(right.path));
}
