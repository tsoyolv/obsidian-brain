import { z } from "zod";

/**
 * Minimal zod → JSON Schema converter used to advertise tool parameters to
 * the LLM tool-calling API. Covers the shapes the agent's tool inputs
 * actually use today (objects of primitives / enums / arrays / optionals);
 * deliberately not a full implementation.
 *
 * If you find yourself reaching for a feature this helper doesn't handle,
 * prefer keeping the tool's `parameters` schema simple before extending
 * this. JSON Schema generation is a side-channel; the zod schema remains
 * the source of truth that actually validates LLM-supplied args.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}

export type JsonSchema = Record<string, unknown>;

function convert(schema: z.ZodTypeAny): JsonSchema {
  // Unwrap modifiers that don't change the underlying shape from a JSON
  // Schema standpoint (default values are handled by the runtime, not the
  // model; nullable becomes `type: [..., "null"]`).
  if (schema instanceof z.ZodOptional) {
    return convert(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    const inner = convert(schema.removeDefault());
    return { ...inner, default: schema._def.defaultValue() };
  }
  if (schema instanceof z.ZodNullable) {
    const inner = convert(schema.unwrap());
    const t = inner.type;
    if (typeof t === "string") {
      return { ...inner, type: [t, "null"] };
    }
    if (Array.isArray(t) && !t.includes("null")) {
      return { ...inner, type: [...t, "null"] };
    }
    return inner;
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value);
      if (!isOptional(value)) required.push(key);
    }
    const out: JsonSchema = {
      type: "object",
      properties,
      additionalProperties: false,
    };
    if (required.length > 0) out.required = required;
    const desc = describe(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodString) {
    const out: JsonSchema = { type: "string" };
    const desc = describe(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodNumber) {
    const out: JsonSchema = { type: "number" };
    const desc = describe(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodBoolean) {
    const out: JsonSchema = { type: "boolean" };
    const desc = describe(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodArray) {
    const out: JsonSchema = {
      type: "array",
      items: convert(schema.element),
    };
    const desc = describe(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: [...schema.options] };
  }

  if (schema instanceof z.ZodLiteral) {
    const v = schema.value;
    return { type: typeof v as "string", const: v };
  }

  if (schema instanceof z.ZodUnion) {
    const opts = schema.options as z.ZodTypeAny[];
    return { anyOf: opts.map((o) => convert(o)) };
  }

  // Fallback for anything we don't model yet — accept arbitrary JSON.
  // Tools whose params hit this path lose precise schema advertisement to
  // the model but still get full zod validation on the way in.
  return {};
}

function describe(schema: z.ZodTypeAny): string | undefined {
  return schema.description;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodOptional) return true;
  if (schema instanceof z.ZodDefault) return true;
  return false;
}
