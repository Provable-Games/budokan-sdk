/**
 * Convert a snake_case string to camelCase.
 */
function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Convert a camelCase string to snake_case.
 */
function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Deeply convert all keys in an object from snake_case to camelCase.
 */
export function snakeToCamel<T>(obj: unknown): T {
  if (Array.isArray(obj)) {
    return obj.map((item) => snakeToCamel(item)) as T;
  }
  if (obj !== null && typeof obj === "object" && !(obj instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[toCamelCase(key)] = snakeToCamel(value);
    }
    return result as T;
  }
  return obj as T;
}

/**
 * Deeply convert all keys in an object from camelCase to snake_case.
 */
export function camelToSnake<T>(obj: unknown): T {
  if (Array.isArray(obj)) {
    return obj.map((item) => camelToSnake(item)) as T;
  }
  if (obj !== null && typeof obj === "object" && !(obj instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[toSnakeCase(key)] = camelToSnake(value);
    }
    return result as T;
  }
  return obj as T;
}
