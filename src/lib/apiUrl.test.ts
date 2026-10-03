import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl } from './apiUrl';

test('apiUrl: VITE_API_URL unset leaves paths relative (the web build is unchanged)', () => {
  assert.equal(apiUrl('/api/health'), '/api/health');
  assert.equal(apiUrl('/uploads/floor-plans/a.png'), '/uploads/floor-plans/a.png');
  assert.equal(apiUrl('/api/shifts/loc?weekStart=2026-10-05', ''), '/api/shifts/loc?weekStart=2026-10-05');
});

test('apiUrl: a configured base becomes an absolute URL with exactly one slash at the join', () => {
  assert.equal(apiUrl('/api/health', 'https://api.example.com'), 'https://api.example.com/api/health');
  assert.equal(apiUrl('/api/health', 'https://api.example.com/'), 'https://api.example.com/api/health');
  assert.equal(apiUrl('/uploads/policy-documents/x.pdf', 'http://10.0.2.2:4000//'), 'http://10.0.2.2:4000/uploads/policy-documents/x.pdf');
});
