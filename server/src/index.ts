import 'dotenv/config';
import { createApp } from './app.js';
import { checkProductionEnv } from './lib/productionGuards.js';
import { installLogContext } from './lib/requestContext.js';

// Request ids on every log line written while handling a request; phone numbers masked in all logs.
installLogContext();

const PORT = Number(process.env.PORT ?? 4000);

// Before the app is built, so an unsafe deploy fails its health check instead of serving traffic.
let warnings: string[];
try {
  ({ warnings } = checkProductionEnv());
} catch (err) {
  console.error(`[startup] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
for (const warning of warnings) console.warn(`[startup] ${warning}`);

const app = createApp();
app.listen(PORT, () => {
  console.log(`ShiftSync API listening on http://localhost:${PORT}`);
});
