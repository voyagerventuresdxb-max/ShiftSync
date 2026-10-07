import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, uploadFailure, UPLOAD_CONNECTION_LOST_MESSAGE, UPLOAD_TIMED_OUT_MESSAGE } from './schedules';

test('uploadFailure: a bare proxy timeout reads as a plain "took too long" message', () => {
  const mapped = uploadFailure(new ApiError('Request failed (504)', 504));
  assert.ok(mapped instanceof ApiError);
  assert.equal(mapped.message, UPLOAD_TIMED_OUT_MESSAGE);
  assert.equal(mapped.errorCode, 'upload_timed_out');
});

test('uploadFailure: a dropped connection reads as one', () => {
  const mapped = uploadFailure(new TypeError('Failed to fetch'));
  assert.ok(mapped instanceof ApiError);
  assert.equal(mapped.message, UPLOAD_CONNECTION_LOST_MESSAGE);
});

test("uploadFailure: the API's own errors keep their message", () => {
  const own = new ApiError('No valid shift rows could be parsed from this file.', 422);
  assert.equal(uploadFailure(own), own);
  const consent = new ApiError('Needs consent', 422, undefined, 'ai_consent_required');
  assert.equal(uploadFailure(consent), consent);
  const unavailable = new ApiError('The AI reader is busy.', 503, undefined, 'vision_unavailable');
  assert.equal(uploadFailure(unavailable), unavailable);
});
