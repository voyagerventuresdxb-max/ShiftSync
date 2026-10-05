import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearOfflineCache, isNetworkFailure, loadOffline, offlineLabel, saveOffline } from './offlineCache';

class MemoryStorage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

test('a saved copy reads back with its save time, per person', () => {
  saveOffline('user-a', 'myShifts', { shifts: [1, 2] });
  const a = loadOffline<{ shifts: number[] }>('user-a', 'myShifts');
  assert.deepEqual(a?.data, { shifts: [1, 2] });
  assert.ok(!Number.isNaN(Date.parse(a!.savedAt)));
  assert.equal(loadOffline('user-b', 'myShifts'), null, "another person never sees this person's copy");
});

test('clearing removes every person\'s copy and nothing else', () => {
  saveOffline('user-a', 'myShifts', 1);
  saveOffline('user-b', 'rotaWeek', 2);
  localStorage.setItem('shiftsync.session', 'keep-me');
  clearOfflineCache();
  assert.equal(loadOffline('user-a', 'myShifts'), null);
  assert.equal(loadOffline('user-b', 'rotaWeek'), null);
  assert.equal(localStorage.getItem('shiftsync.session'), 'keep-me');
});

test('an evicted, corrupt or missing store behaves as "nothing cached" and never throws', () => {
  localStorage.setItem('shiftsync.offline.v1.user-a.myShifts', '{not json');
  assert.equal(loadOffline('user-a', 'myShifts'), null);
  localStorage.setItem('shiftsync.offline.v1.user-a.myShifts', JSON.stringify({ savedAt: 'yesterday', data: 1 }));
  assert.equal(loadOffline('user-a', 'myShifts'), null, 'an unreadable save time is not trusted');
  const throwing = {
    get length(): number {
      throw new Error('denied');
    },
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('quota');
    },
    key() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = throwing;
  assert.doesNotThrow(() => saveOffline('user-a', 'myShifts', 1));
  assert.equal(loadOffline('user-a', 'myShifts'), null);
  assert.doesNotThrow(() => clearOfflineCache());
});

test('only a failure to reach the server counts as offline, not an error the server answered', () => {
  assert.equal(isNetworkFailure(new TypeError('Failed to fetch')), true);
  assert.equal(isNetworkFailure(Object.assign(new Error('Request failed (500)'), { status: 500 })), false);
});

test('the label always says offline and when the copy was saved', () => {
  const now = new Date('2026-10-05T12:00:00');
  assert.match(offlineLabel(new Date('2026-10-05T09:05:00').toISOString(), now), /^Offline — last updated 09:05$/);
  assert.match(offlineLabel(new Date('2026-10-03T21:30:00').toISOString(), now), /^Offline — last updated Sat 3 Oct, 21:30$/);
});
