# Manual end-to-end upload test

1. Set `DATABASE_URL` in `.env` (Supabase pooler connection string — see `.env.example`).
2. Apply migrations: `npx prisma migrate dev`
3. Seed a test Location/Roles/Users: `npx tsx server/scripts/seed-test-data.ts`
4. Regenerate the sample file if needed: `npx tsx server/scripts/make-sample-xlsx.mjs`
5. Start the API: `npm run server:dev`
6. Upload + preview (no DB writes yet):

```bash
curl -s -X POST http://localhost:4000/api/schedules/upload \
  -F "locationId=seed-location" \
  -F "file=@server/test-fixtures/sample-roster.xlsx"
```

Copy the `batchId` from the response, then confirm to persist:

```bash
curl -s -X POST http://localhost:4000/api/schedules/upload/<batchId>/confirm \
  -H "Content-Type: application/json" -d '{}'
```

7. Verify rows landed in Postgres: `npx prisma studio` (browse the `shifts` table), or query via a one-off `tsx` script using `server/src/lib/prisma.ts`.
