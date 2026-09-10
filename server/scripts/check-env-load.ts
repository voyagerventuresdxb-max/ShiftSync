import 'dotenv/config';

const key = process.env.GEMINI_API_KEY;
console.log('GEMINI_API_KEY loaded:', !!key);
if (key) {
  console.log('Length:', key.length);
  console.log('First 8 chars:', key.slice(0, 8));
  console.log('Has quotes:', key.includes('"'));
}
