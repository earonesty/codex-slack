import { record } from './config.ts';

/** Validate simple MCP forms before returning user-entered values to a server. */
export function mcpFormContent(schema: Record<string, unknown>, text: string): Record<string, unknown> {
  const content: unknown = JSON.parse(text);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Enter a JSON object.');
  const values = record(content);
  const properties = record(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) if (!Object.hasOwn(values, String(key))) throw new Error(`Missing required field: ${key}`);
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(properties, key)) throw new Error(`Unknown field: ${key}`);
    const field = record(properties[key]);
    if (field.type === 'string' && typeof value !== 'string'
      || field.type === 'boolean' && typeof value !== 'boolean'
      || field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))
      || field.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) throw new Error(`Invalid type for ${key}`);
    if (Array.isArray(field.enum) && !field.enum.includes(value)) throw new Error(`Invalid choice for ${key}`);
    if (typeof value === 'string' && (typeof field.minLength === 'number' && value.length < field.minLength
      || typeof field.maxLength === 'number' && value.length > field.maxLength)) throw new Error(`Invalid length for ${key}`);
    if (typeof value === 'number' && (typeof field.minimum === 'number' && value < field.minimum
      || typeof field.maximum === 'number' && value > field.maximum)) throw new Error(`Out of range: ${key}`);
  }
  return values;
}

export function supportedMcpForm(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object' || Object.keys(schema).some(k => !['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema'].includes(k))) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required)
    || schema.required.some(k => typeof k !== 'string' || !Object.hasOwn(record(schema.properties), k)))) return false;
  return Object.entries(record(schema.properties)).every(([key, raw]) => {
    const field = record(raw);
    // Credentials must remain in the native client, never in Slack forms.
    return !/password|secret|token|credential/i.test(key)
      && !field.writeOnly && field.format !== 'password'
      && ['string', 'boolean', 'number', 'integer'].includes(String(field.type))
      && Object.keys(field).every(k => ['type', 'title', 'description', 'enum', 'enumNames', 'default',
        'minLength', 'maxLength', 'minimum', 'maximum'].includes(k));
  });
}
