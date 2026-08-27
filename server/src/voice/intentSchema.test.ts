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
