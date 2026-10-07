/**
 * Longest venue name (after trimming) the API accepts — at signup and on a
 * rename (`PATCH /api/locations/:id`). The name sits in the one-line app
 * header, invite share texts and the staff rota, so it is meant to be short.
 * Shared so the inputs' `maxLength` and the server's check can't drift.
 */
export const VENUE_NAME_MAX_LENGTH = 80;
