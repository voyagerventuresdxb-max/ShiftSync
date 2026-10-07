import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAFF_INTENTS, MANAGER_INTENTS, intentSchemaFor } from './intentSchema.js';

test('MANAGER_INTENTS is a strict superset of STAFF_INTENTS', () => {
  for (const intent of STAFF_INTENTS) {
    assert.ok(MANAGER_INTENTS.includes(intent), `MANAGER_INTENTS is missing staff intent "${intent}"`);
  }
});

test('intentSchemaFor(STAFF) restricts the enum to STAFF_INTENTS plus UNRECOGNIZED', () => {
  const schema = intentSchemaFor('STAFF');
  const intentProp = schema.properties.intent;
  assert.deepEqual([...intentProp.enum].sort(), [...STAFF_INTENTS, 'UNRECOGNIZED'].sort());
});

test('intentSchemaFor(MANAGER) and intentSchemaFor(OWNER) both restrict to MANAGER_INTENTS plus UNRECOGNIZED', () => {
  const managerSchema = intentSchemaFor('MANAGER');
  const ownerSchema = intentSchemaFor('OWNER');
  assert.deepEqual([...managerSchema.properties.intent.enum].sort(), [...MANAGER_INTENTS, 'UNRECOGNIZED'].sort());
  assert.deepEqual([...ownerSchema.properties.intent.enum].sort(), [...MANAGER_INTENTS, 'UNRECOGNIZED'].sort());
});

test('every key is required (nullable ones answer null) and ordered: the intent first, who next, the sentences and confidence last', () => {
  for (const role of ['STAFF', 'MANAGER'] as const) {
    const schema = intentSchemaFor(role) as unknown as {
      properties: Record<string, { nullable?: boolean; items?: { properties: Record<string, unknown>; required: string[]; propertyOrdering: string[] } }>;
      required: string[];
      propertyOrdering: string[];
    };
    const keys = Object.keys(schema.properties);
    assert.deepEqual([...schema.required].sort(), [...keys].sort(), `${role}: every key required`);
    assert.deepEqual([...schema.propertyOrdering].sort(), [...keys].sort(), `${role}: every key ordered`);
    assert.equal(schema.propertyOrdering[0], 'intent');
    assert.equal(schema.propertyOrdering[1], 'targetUserName');
    assert.ok(schema.propertyOrdering.indexOf('end') < schema.propertyOrdering.indexOf('summary'));
    assert.ok(schema.propertyOrdering.indexOf('summary') < schema.propertyOrdering.indexOf('confidence'));
    // Required is not "must be non-null": everything but the intent and the sentence may be null.
    for (const key of keys.filter((k) => k !== 'intent' && k !== 'summary')) assert.equal(schema.properties[key]!.nullable, true, `${role}: ${key} nullable`);
    const items = schema.properties.alternatives!.items!;
    assert.deepEqual([...items.required].sort(), Object.keys(items.properties).sort());
    assert.deepEqual([...items.propertyOrdering].sort(), Object.keys(items.properties).sort());
  }
});
