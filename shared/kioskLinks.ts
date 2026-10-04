/**
 * Shared between the server (which mints kiosk links and checks the header)
 * and the client (which opens the link and sends the header). The token rides
 * in the URL FRAGMENT (`#k=<token>`) so it never reaches server access logs,
 * proxies, or a chat app's link-preview fetch.
 */
export const KIOSK_PATH = '/kiosk';

/** The header a kiosk screen sends its token in on the four venue reads it may make. */
export const KIOSK_TOKEN_HEADER = 'X-Kiosk-Token';
