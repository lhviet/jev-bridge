/**
 * A small JSON Schema checker for the tests — just the keywords jev-bridge's
 * own schemas use, so the project keeps its zero dependencies. Two jobs:
 *
 *   check(schema, value)  the errors, if any, of `value` against `schema`
 *   unknownKeywords(s)    keywords outside that subset, so a typo in a schema
 *                         ("requried") fails a test instead of passing silently
 *
 * The full check against the official MCP JSON Schema, with Ajv, is
 * evidence/validate-wire.mjs.
 */

const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', '$schema']);
const KEYWORDS = new Set([
  'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties',
  'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'oneOf', 'anyOf',
]);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const fits = (t, v) => (t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' : typeOf(v) === t);

export function check(schema, value, at = '$') {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at}: nothing is allowed here`];
  const errors = [];
  const add = (msg) => errors.push(`${at}: ${msg}`);

  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => fits(t, value))) add(`expected ${types.join(' | ')}, got ${typeOf(value)}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) add(`expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) add(`not one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(`below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`above ${schema.maximum}`);
  }
  if (typeOf(value) === 'object') {
    const keys = Object.keys(value);
    for (const r of schema.required ?? []) if (!(r in value)) add(`missing "${r}"`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) add(`fewer than ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) add(`more than ${schema.maxProperties} properties`);
    for (const k of keys) {
      if (schema.properties && k in schema.properties) errors.push(...check(schema.properties[k], value[k], `${at}.${k}`));
      else if (schema.additionalProperties !== undefined) errors.push(...check(schema.additionalProperties, value[k], `${at}.${k}`));
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...check(schema.items, v, `${at}[${i}]`)));
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => check(s, value, at).length === 0).length;
    if (passing !== 1) add(`matches ${passing} of the oneOf branches, not exactly 1`);
  }
  if (schema.anyOf && !schema.anyOf.some((s) => check(s, value, at).length === 0)) add('matches none of the anyOf branches');
  return errors;
}

export function unknownKeywords(schema, at = '$') {
  if (typeof schema !== 'object' || schema === null) return [];
  const found = [];
  for (const [k, v] of Object.entries(schema)) {
    if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) found.push(`${at}.${k}`);
    if (k === 'properties') for (const [name, sub] of Object.entries(v)) found.push(...unknownKeywords(sub, `${at}.properties.${name}`));
    if (k === 'additionalProperties' || k === 'items') found.push(...unknownKeywords(v, `${at}.${k}`));
    if (k === 'oneOf' || k === 'anyOf') v.forEach((sub, i) => found.push(...unknownKeywords(sub, `${at}.${k}[${i}]`)));
  }
  return found;
}
