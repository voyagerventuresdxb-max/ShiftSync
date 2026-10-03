import 'dotenv/config';

// Presence and shape checks only. Never print any part of a key: not its prefix, suffix or length.
for (const name of ['GEMINI_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON'] as const) {
  const value = process.env[name];
  console.log(`${name} loaded:`, !!value);
  if (value) {
    console.log('  wrapped in quotes:', /^["']|["']$/.test(value));
    console.log('  leading/trailing whitespace:', value !== value.trim());
  }
}
