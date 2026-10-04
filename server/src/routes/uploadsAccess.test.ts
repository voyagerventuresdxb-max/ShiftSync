import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app.js';

const UPLOADS = join(import.meta.dirname, '..', '..', 'uploads');

/**
 * Uploaded files are readable only through their session-gated routes. No
 * other spelling of the same path (encoded separators, dot segments, double
 * slashes) and no other /uploads path may serve a file.
 */
test('uploaded files are only served through their session-gated routes, however the path is spelled', async () => {
  const files = [
    { dir: 'floor-plans', name: `${randomUUID()}.png` },
    { dir: 'policy-documents', name: `${randomUUID()}.pdf` },
  ];
  for (const { dir, name } of files) {
    mkdirSync(join(UPLOADS, dir), { recursive: true });
    writeFileSync(join(UPLOADS, dir, name), 'uploads-access-test');
  }
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const { dir, name } of files) {
      const gated = await fetch(`${base}/uploads/${dir}/${name}`);
      assert.equal(gated.status, 401, `${dir}: the gated route still asks for a session`);
      for (const path of [
        `/uploads/${dir}%2F${name}`,
        `/uploads/${dir}%2f${name}`,
        `/uploads/${dir}%5C${name}`,
        `/uploads/${dir}%5c${name}`,
        `/uploads/./${dir}/${name}`,
        `/uploads//${dir}/${name}`,
      ]) {
        const res = await fetch(`${base}${path}`);
        const body = await res.text();
        assert.ok(res.status === 401 || res.status === 404, `${dir} variant must not be served (got ${res.status})`);
        assert.ok(!body.includes('uploads-access-test'), `${dir} variant must not return the file`);
      }
    }
    const other = await fetch(`${base}/uploads/anything-else.txt`);
    assert.equal(other.status, 404, 'no other /uploads path serves anything');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const { dir, name } of files) rmSync(join(UPLOADS, dir, name), { force: true });
  }
});
