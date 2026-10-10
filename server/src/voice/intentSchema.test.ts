import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAFF_INTENTS, MANAGER_INTENTS, READ_VOICE_INTENTS, TOOL_ARG_NAMES, intentSchemaFor } from './intentSchema.js';
import { isReadVoiceIntent } from '../../../shared/voiceIntents.js';

type Schema = {
  properties: Record<string, { enum?: string[]; nullable?: boolean; properties?: Record<string, { nullable?: boolean; description?: string }>; required?: string[]; items?: { properties: Record<string, unknown>; required: string[]; propertyOrdering: string[] } }>;
  required: string[];
  propertyOrdering: string[];
};

test('MANAGER_INTENTS is a strict superset of STAFF_INTENTS', () => {
  for (const intent of STAFF_INTENTS) {
    assert.ok(MANAGER_INTENTS.includes(intent), `MANAGER_INTENTS is missing staff intent "${intent}"`);
  }
});

test('the STAFF tool enum is the staff tools plus DECLINED and UNRECOGNIZED; managers and owners get every tool', () => {
  const staff = intentSchemaFor('STAFF') as unknown as Schema;
  assert.deepEqual([...staff.properties.tool!.enum!].sort(), [...STAFF_INTENTS, 'DECLINED', 'UNRECOGNIZED'].sort());
  for (const role of ['MANAGER', 'OWNER'] as const) {
    const schema = intentSchemaFor(role) as unknown as Schema;
    assert.deepEqual([...schema.properties.tool!.enum!].sort(), [...MANAGER_INTENTS, 'DECLINED', 'UNRECOGNIZED'].sort());
  }
  assert.ok(!staff.properties.tool!.enum!.includes('PUBLISH_ROTA'));
  assert.ok(!staff.properties.tool!.enum!.includes('CANCEL_SHIFT'));
});

test('the model answers with words as heard, never ids: no argument is an id', () => {
  for (const role of ['STAFF', 'MANAGER'] as const) {
    const schema = intentSchemaFor(role) as unknown as Schema;
    const args = schema.properties.args!;
    assert.deepEqual(Object.keys(args.properties!).sort(), [...TOOL_ARG_NAMES].sort());
    for (const key of Object.keys(args.properties!)) {
      assert.doesNotMatch(key, /id$/i, `${role}: ${key} looks like an id`);
      assert.equal(args.properties![key]!.nullable, true, `${role}: ${key} nullable`);
    }
    assert.deepEqual([...args.required!].sort(), [...TOOL_ARG_NAMES].sort(), 'every argument key is required (null when unused)');
  }
});

test('every top-level key is required and ordered: the tool first, its arguments next, the sentences and confidence after', () => {
  for (const role of ['STAFF', 'MANAGER'] as const) {
    const schema = intentSchemaFor(role) as unknown as Schema;
    const keys = Object.keys(schema.properties);
    assert.deepEqual([...schema.required].sort(), [...keys].sort());
    assert.deepEqual([...schema.propertyOrdering].sort(), [...keys].sort());
    assert.deepEqual(schema.propertyOrdering.slice(0, 4), ['tool', 'args', 'summary', 'confidence']);
    const items = schema.properties.alternatives!.items!;
    assert.deepEqual([...items.required].sort(), Object.keys(items.properties).sort());
    assert.deepEqual([...items.propertyOrdering].sort(), Object.keys(items.properties).sort());
  }
});

test('the rota reads WHO_IS_OFF and COVERAGE are questions every role may ask; shift types and departments are arguments as heard', () => {
  for (const role of ['STAFF', 'MANAGER', 'OWNER'] as const) {
    const schema = intentSchemaFor(role) as unknown as Schema;
    assert.ok(schema.properties.tool!.enum!.includes('WHO_IS_OFF'), `${role}: WHO_IS_OFF`);
    assert.ok(schema.properties.tool!.enum!.includes('COVERAGE'), `${role}: COVERAGE`);
    const args = schema.properties.args!.properties!;
    assert.match(args.shiftType!.description!, /named shift as said/);
    assert.match(args.department!.description!, /COVERAGE: a department as said/);
  }
  for (const intent of ['WHO_IS_OFF', 'COVERAGE']) {
    assert.ok((READ_VOICE_INTENTS as readonly string[]).includes(intent));
    assert.ok(isReadVoiceIntent(intent));
  }
});
