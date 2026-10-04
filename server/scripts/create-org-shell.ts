/**
 * Creates a venue shell (Organization + Location + OWNER user + default
 * roles) and prints the owner's first one-time login link. This is how a
 * pilot GM gets in when LOGIN_METHODS=links (no self-signup): send them the
 * printed link on WhatsApp; their tap lands in the onboarding wizard at Venue.
 *
 * Usage (locally, against this branch's schema):
 *   npm run org:create -- --venue "Il Gattopardo" --owner "Layla Haddad" --phone +971501234567
 * On the server: tsx server/scripts/create-org-shell.ts --venue … --owner … --phone …
 *
 * The link is printed to stdout once and never stored in plaintext; run the
 * script again (or have a platform admin issue a new link) if it is lost.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createOrgShell } from '../src/lib/actions/adminActions.js';
import { prisma } from '../src/lib/prisma.js';

const { values } = parseArgs({
  options: { venue: { type: 'string' }, owner: { type: 'string' }, phone: { type: 'string' } },
  strict: true,
});

if (!values.venue || !values.owner || !values.phone) {
  console.error('Usage: npm run org:create -- --venue "<venue name>" --owner "<owner full name>" --phone <phone>');
  process.exit(2);
}

try {
  const { location, owner, link } = await createOrgShell({ venueName: values.venue, ownerFullName: values.owner, ownerPhone: values.phone });
  console.log(`Created venue "${location.name}" (location ${location.id}) with owner ${owner.fullName} (${owner.phone}).`);
  console.log('');
  console.log(`Login link (works once, expires ${link.expiresAt.toISOString()}):`);
  console.log(link.url);
  console.log('');
  console.log(`Share text: ${link.shareText}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
