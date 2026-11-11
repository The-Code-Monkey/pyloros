export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalize(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("cannot serialize a non-finite number");
      }
      return value;
    case "object":
      break;
    default:
      throw new TypeError(`cannot serialize a value of type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : canonicalize(item),
    );
  }

  const record = value as Record<string, unknown>;
  const result: { [key: string]: JsonValue } = {};

  for (const key of Object.keys(record).sort()) {
    const item = record[key];

    if (item === undefined) {
      continue;
    }

    result[key] = canonicalize(item);
  }

  return result;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
