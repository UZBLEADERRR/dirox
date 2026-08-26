/**
 * A small, dependency-free schema validator.
 *
 * Every API boundary and every agent tool declares a schema. The same
 * definitions are reused to generate JSON Schema for model tool-calling, so a
 * tool can never be described to a model differently from how it is enforced.
 */

import { validationFailed } from './errors.js';

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const t = {
  string: (opts = {}) => ({ type: 'string', ...opts }),
  number: (opts = {}) => ({ type: 'number', ...opts }),
  integer: (opts = {}) => ({ type: 'integer', ...opts }),
  boolean: (opts = {}) => ({ type: 'boolean', ...opts }),
  enum: (values, opts = {}) => ({ type: 'string', enum: values, ...opts }),
  array: (items, opts = {}) => ({ type: 'array', items, ...opts }),
  object: (properties, opts = {}) => ({ type: 'object', properties, ...opts }),
  any: (opts = {}) => ({ type: 'any', ...opts })
};

function checkValue(value, schema, path, errors) {
  const label = path || 'value';

  if (value === undefined || value === null) {
    if (schema.default !== undefined) return schema.default;
    if (schema.required) errors.push({ path: label, message: 'is required' });
    return undefined;
  }

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') { errors.push({ path: label, message: 'must be a string' }); return undefined; }
      let out = schema.trim === false ? value : value.trim();
      if (schema.lower) out = out.toLowerCase();
      if (schema.enum && !schema.enum.includes(out)) {
        errors.push({ path: label, message: `must be one of: ${schema.enum.join(', ')}` });
        return undefined;
      }
      if (schema.min !== undefined && out.length < schema.min) errors.push({ path: label, message: `must be at least ${schema.min} characters` });
      if (schema.max !== undefined && out.length > schema.max) {
        if (schema.truncate) out = out.slice(0, schema.max);
        else errors.push({ path: label, message: `must be at most ${schema.max} characters` });
      }
      if (schema.pattern && !schema.pattern.test(out)) errors.push({ path: label, message: schema.patternMessage || 'has an invalid format' });
      if (schema.required && !out) errors.push({ path: label, message: 'is required' });
      return out;
    }
    case 'number':
    case 'integer': {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) { errors.push({ path: label, message: 'must be a number' }); return undefined; }
      if (schema.type === 'integer' && !Number.isInteger(n)) { errors.push({ path: label, message: 'must be an integer' }); return undefined; }
      if (schema.min !== undefined && n < schema.min) errors.push({ path: label, message: `must be >= ${schema.min}` });
      if (schema.max !== undefined && n > schema.max) errors.push({ path: label, message: `must be <= ${schema.max}` });
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      errors.push({ path: label, message: 'must be a boolean' });
      return undefined;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push({ path: label, message: 'must be an array' }); return undefined; }
      if (schema.max !== undefined && value.length > schema.max) errors.push({ path: label, message: `must contain at most ${schema.max} items` });
      if (schema.min !== undefined && value.length < schema.min) errors.push({ path: label, message: `must contain at least ${schema.min} items` });
      const limit = schema.max ?? value.length;
      return value.slice(0, limit).map((item, i) => checkValue(item, schema.items || t.any(), `${label}[${i}]`, errors));
    }
    case 'object': {
      if (!isPlain(value)) { errors.push({ path: label, message: 'must be an object' }); return undefined; }
      const out = {};
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        const result = checkValue(value[key], sub, path ? `${path}.${key}` : key, errors);
        if (result !== undefined) out[key] = result;
      }
      if (schema.passthrough) {
        for (const [key, item] of Object.entries(value)) if (!(key in out) && !(key in (schema.properties || {}))) out[key] = item;
      }
      return out;
    }
    default:
      return value;
  }
}

/** Validate and coerce. Throws a 422 with a field-level report on failure. */
export function parse(schema, input) {
  const errors = [];
  const value = checkValue(input, schema, '', errors);
  if (errors.length) throw validationFailed(errors.slice(0, 20));
  return value;
}

/** Non-throwing variant used where a partial result is still useful. */
export function safeParse(schema, input) {
  const errors = [];
  const value = checkValue(input, schema, '', errors);
  return { ok: errors.length === 0, value, errors };
}

/** Render a schema as JSON Schema for provider tool-calling payloads. */
export function toJsonSchema(schema) {
  if (!schema || schema.type === 'any') return {};
  const base = {};
  if (schema.description) base.description = schema.description;
  switch (schema.type) {
    case 'object': {
      base.type = 'object';
      base.properties = {};
      const required = [];
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        base.properties[key] = toJsonSchema(sub);
        if (sub.required) required.push(key);
      }
      if (required.length) base.required = required;
      base.additionalProperties = Boolean(schema.passthrough);
      return base;
    }
    case 'array':
      return { ...base, type: 'array', items: toJsonSchema(schema.items || t.any()) };
    case 'integer':
      return { ...base, type: 'integer' };
    default: {
      base.type = schema.type;
      if (schema.enum) base.enum = schema.enum;
      return base;
    }
  }
}

export const uuid = (opts = {}) => t.string({
  pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  patternMessage: 'must be a UUID',
  max: 36,
  ...opts
});

export const email = (opts = {}) => t.string({
  pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  patternMessage: 'must be a valid email address',
  max: 254,
  lower: true,
  ...opts
});

export default { t, parse, safeParse, toJsonSchema, uuid, email };
