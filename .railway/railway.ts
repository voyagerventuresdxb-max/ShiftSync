// DRAFT successor to railway.json (#52). Railway never reads this file during a deploy:
// only `railway config plan` / `railway config apply` do, and they refuse while railway.json
// still manages the service. Follow docs/railway-deploy-procedure.md (non-production first).
// Needs the SDK at plan time: `npm install --no-save railway@3.12.0` (typechecked against it).
import { defineRailway, project, service } from "railway/iac";

// Named partial: this file owns only the API service, so an apply can never delete the
// Postgres service or anything else it doesn't declare.
export const partial = "shiftsync-api";

export default defineRailway((ctx) => {
  // Use the linked project's own name so a plan never proposes renaming it.
  if (!ctx.projectName) throw new Error("Run via `railway config plan` from a linked directory.");

  const api = service("shiftsync-api", {
    build: {
      builder: "RAILPACK",
      buildCommand: "npx prisma generate",
    },
    deploy: {
      startCommand: "npm run server:start",
      healthcheckPath: "/api/health",
      healthcheckTimeout: 120,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
  });

  return project(ctx.projectName, { resources: [api] });
});
