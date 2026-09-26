import 'dotenv/config';
import { createApp } from './app.js';
import { checkProductionEnv } from './lib/productionGuards.js';

const PORT = Number(process.env.PORT ?? 4000);

// Refuses to boot in production with a login-bypass flag on or without
// FRONTEND_ORIGIN; logs (loudly) any flag that is merely dangerous. Runs
// before the app is even built so a bad deploy fails its health check
// instead of serving traffic.
let warnings: string[];
try {
  ({ warnings } = checkProductionEnv());
} catch (err) {
  console.error(`[startup] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
for (const warning of warnings) console.warn(`[SECURITY] ${warning}`);

const app = createApp();
app.listen(PORT, () => {
  console.log(`ShiftSync API listening on http://localhost:${PORT}`);
});
