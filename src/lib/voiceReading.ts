import { READ_VOICE_INTENTS, type ParsedIntent } from '@/api/voice';

/**
 * Whether a reading from /api/voice/parse-intent has every field the confirm sheet draws. A reading
 * that doesn't (a server bug, a cut-off answer) is never shown: it would throw while drawing, and
 * one error inside the voice sheet used to replace the whole app with the router's error page.
 */

const str = (v: unknown): v is string => typeof v === 'string';
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optStr = (v: unknown) => v === undefined || v === null || str(v);

function isAnswer(a: unknown): boolean {
  return obj(a) && str(a.title) && str(a.emptyText) && Array.isArray(a.items) && a.items.every((i) => obj(i) && str(i.primary));
}

function isReadingList(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every(isWellFormedReading));
}

const FIELDS: Record<string, (r: Record<string, unknown>) => boolean> = {
  MARK_AVAILABILITY: (r) => str(r.date) && (r.type === 'UNAVAILABLE' || r.type === 'PREFERRED_OFF'),
  REQUEST_SWAP: (r) => str(r.shiftId) && str(r.targetUserId) && optStr(r.targetUserName),
  REQUEST_TIME_OFF: (r) => str(r.startDate) && str(r.endDate),
  APPROVE_SWAP: (r) => str(r.swapRequestId),
  DECLINE_SWAP: (r) => str(r.swapRequestId),
  APPROVE_JOIN: (r) => str(r.joinRequestId),
  DECLINE_JOIN: (r) => str(r.joinRequestId),
  CREATE_SHIFT: (r) =>
    str(r.roleId) && str(r.date) && str(r.start) && str(r.end) && optStr(r.userId) && (r.second === undefined || (obj(r.second) && str(r.second.start) && str(r.second.end))),
  EDIT_SHIFT: (r) => str(r.shiftId),
  CANCEL_SHIFT: (r) => str(r.shiftId) && obj(r.details) && str(r.details.date) && str(r.details.start) && str(r.details.end),
  ASSIGN_SECTION: (r) => str(r.sectionId) && str(r.staffId) && str(r.shiftDate) && (r.period === 'AM' || r.period === 'PM'),
  PUBLISH_ROTA: (r) => str(r.weekStart) && (r.counts === undefined || (obj(r.counts) && typeof r.counts.shiftsChanging === 'number' && typeof r.counts.peopleNotified === 'number')),
  APPLY_ROTA_TEMPLATE: (r) => str(r.weekStart) && str(r.templateName),
  POST_ANNOUNCEMENT: (r) => str(r.content),
  POST_SHOUTOUT: (r) => str(r.targetUserId) && str(r.targetUserName) && str(r.content),
  DECLINED: (r) => str(r.message),
  UNRECOGNIZED: (r) =>
    optStr(r.reason) &&
    isReadingList(r.options) &&
    isReadingList(r.team) &&
    (r.retry === undefined || (Array.isArray(r.retry) && r.retry.every((x) => obj(x) && str(x.person) && str(x.text)))),
};
for (const read of READ_VOICE_INTENTS) FIELDS[read] = (r) => (read === 'QUERY_MY_SCHEDULE' && r.answer === undefined) || isAnswer(r.answer);

export function isWellFormedReading(reading: unknown): reading is ParsedIntent {
  if (!obj(reading) || !str(reading.intent) || !str(reading.summary)) return false;
  const fields = FIELDS[reading.intent];
  return !!fields && fields(reading);
}
