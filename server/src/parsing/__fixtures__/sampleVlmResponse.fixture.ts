import type { mapVlmResponseToResult } from '../parseVision.js';

/**
 * TEST FIXTURE ONLY. A hand-written VLM response in the Il Gattopardo layout
 * (AM/PM sub-columns, a leave code, management rows). Used by
 * parseVision.test.ts to exercise mapVlmResponseToResult without a Gemini
 * call. This used to live in parseVision.ts as a production fallback that
 * was returned to real managers whenever Gemini was rate-limited — it must
 * never be imported from non-test code again.
 */
export const SAMPLE_VLM_RESPONSE: Parameters<typeof mapVlmResponseToResult>[0] = {
  venueTemplateNotes: 'Test fixture — Il Gattopardo layout with AM/PM sub-columns.',
  legend: [
    { code: 'AL', meaning: 'Annual Leave', category: 'leave' },
    { code: 'DO', meaning: 'Day Off', category: 'day_off' },
    { code: 'PH', meaning: 'Public Holiday', category: 'public_holiday' },
  ],
  employees: [
    { rawName: 'Andrea', role: 'Manager', cells: [
      { date: '2026-08-17', rawText: '11-17', period: 'AM', interpretation: 'worked_shift', startTime: '11:00', endTime: '17:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
      { date: '2026-08-17', rawText: '18-01', period: 'PM', interpretation: 'worked_shift', startTime: '18:00', endTime: '01:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Roberto', role: 'Manager', cells: [
      { date: '2026-08-17', rawText: '09-17', period: 'AM', interpretation: 'worked_shift', startTime: '09:00', endTime: '17:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Alessandro', role: 'Manager', cells: [
      { date: '2026-08-18', rawText: '10-18', period: 'AM', interpretation: 'worked_shift', startTime: '10:00', endTime: '18:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Tomas', role: 'Manager', cells: [
      { date: '2026-08-18', rawText: 'DO', period: null, interpretation: 'day_off', startTime: null, endTime: null, leaveCode: 'DO', confidence: 0.95, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Sintia', role: 'Supervisor', cells: [
      { date: '2026-08-17', rawText: '12-20', period: 'AM', interpretation: 'worked_shift', startTime: '12:00', endTime: '20:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Pratik', role: 'Supervisor', cells: [
      { date: '2026-08-17', rawText: '14-22', period: 'PM', interpretation: 'worked_shift', startTime: '14:00', endTime: '22:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Rojina', role: 'Head Waiter', cells: [
      { date: '2026-08-17', rawText: '09-17', period: 'AM', interpretation: 'worked_shift', startTime: '09:00', endTime: '17:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Hefny', role: 'Waiter', cells: [
      { date: '2026-08-17', rawText: '10-18', period: 'AM', interpretation: 'worked_shift', startTime: '10:00', endTime: '18:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
      { date: '2026-08-17', rawText: '19-01', period: 'PM', interpretation: 'worked_shift', startTime: '19:00', endTime: '01:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
    { rawName: 'Bashkar', role: 'Runner', cells: [
      { date: '2026-08-17', rawText: '11-19', period: 'AM', interpretation: 'worked_shift', startTime: '11:00', endTime: '19:00', leaveCode: null, confidence: 0.9, needsReview: false, reviewReason: null },
    ] },
  ],
  documentAnomalies: [],
};
