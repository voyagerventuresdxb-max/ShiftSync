# Roster vision go-live (Vertex AI)

What turns on AI reading of roster **photos and scanned PDFs** in production, in the order to do
it. Spreadsheets and text PDFs never need this: the deterministic parsers read them first, and
they keep working whether or not vision is on.

Until these steps are done, production has no vision credentials: an image upload answers a
clear 422 ("AI roster reading isn't set up on this server. Upload an Excel/CSV export instead.")
and never shows invented data.

Never paste a key, key file or any part of one into chat, a PR, an issue, a commit or a log.

## 0. What the code expects (checked 2026-10-04)

| Setting | Default | Source |
|---|---|---|
| `VLM_MODEL` | `gemini-3.6-flash` | GA on the Gemini API and Vertex AI; no shutdown date announced ([models](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash), [Vertex model page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-6-flash), [deprecations](https://ai.google.dev/gemini-api/docs/deprecations)). Vertex lists `gemini-3.8-flash` as its eventual replacement, with at least 45 days' notice ([model versions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)). |
| `VLM_FALLBACK_MODEL` | `gemini-3.5-flash-lite` | GA; Vertex retirement "July 21, 2027 or later" ([model versions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)). |
| `GEMINI_VERTEX_LOCATION` | `eu` | Both models are offered on Vertex only on the `global` endpoint and the `us` / `eu` **multi-regions** — not in any single region, `europe-west4` included ([locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations)). `eu` keeps model processing inside the EU. `@google/genai` 2.17.1 sends `eu` to `https://aiplatform.eu.rep.googleapis.com/` (checked in the installed SDK). |

- Gemini **2.5** models retire on Vertex on **2026-10-20** ([model versions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)). Don't set any `gemini-2.5-*` ID.
- If Google retires a model anyway, the server logs `[vision] MODEL NOT AVAILABLE: … model "<id>" …`, tries the fallback model, and if every model is gone the manager sees "AI roster reading is unavailable on this server until its AI model setting is updated…". Fix by setting `VLM_MODEL` / `VLM_FALLBACK_MODEL` and redeploying.
- The API itself runs in Railway region `sfo` (US West). Vertex `eu` pins where the model processes the image; the request passes through the US-hosted API on its way.

## 1. Google Cloud: project and billing

1. https://console.cloud.google.com → project picker → **New project** (e.g. `shiftsync-prod`), or pick the existing one. Note its **project ID** (not the name).
2. **Billing** → link the project to a billing account.
3. **APIs & Services → Library** → search **Vertex AI API** → **Enable**.

## 2. Budget alert and quota cap

1. **Billing → Budgets & alerts → Create budget.** Scope: this project only. Amount: a monthly figure you're comfortable with (e.g. USD 20 for a pilot). Alert thresholds: 50 %, 90 %, 100 % of actual spend, emailed to you. A budget **alerts**; it does not stop spend.
2. **Quota cap (the actual stop):** **IAM & Admin → Quotas & System Limits** → filter *Service: Vertex AI API* → find the generate-content requests-per-minute quota for the base model (`gemini-3.6-flash`, and `gemini-3.5-flash-lite`) in location `eu` → **Edit quotas** → set a low value (e.g. 10 per minute) → submit. The exact quota names in that list were not verified while writing this; pick the per-minute generate-content quota for each model in `eu`.
3. The app adds its own limits on top (`server/src/routes/schedules.ts`): AI reading takes files up to 5 MB and runs at most **once per venue per week** (a successful read starts the week), plus the general roster-upload rate limiter.

## 3. Service account with Vertex AI User only

1. **IAM & Admin → Service Accounts → Create service account.** Name `shiftsync-vision`. No other description needed.
2. **Grant access:** role **Vertex AI User** (`roles/aiplatform.user`). Nothing else — not Editor, not Owner. Done.
3. Open the account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads. This file **is** the secret.
   - If key creation is blocked ("disabled by organization policy"), an org admin has to allow it for this project first.

## 4. Set the variables by hand in Railway

In the Railway dashboard → project `shiftsync` → environment `production` → service `shiftsync-api` → **Variables**:

| Variable | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | open the downloaded `.json` in a text editor, copy **all** of it, paste as the value (the raw editor keeps it on one variable) |
| `GEMINI_VERTEX_PROJECT` | the project ID from step 1 |
| `GEMINI_VERTEX_LOCATION` | leave unset (default `eu`) |

Then delete the downloaded `.json` from your Downloads folder and empty the bin. Railway stages the
change; don't deploy it from the banner — use step 5.

Leave `VLM_MODEL`, `VLM_FALLBACK_MODEL` unset unless you need to change the defaults.

## 5. Check it from your laptop, then deploy

1. Update the linked checkout and run the check with production's variables (this runs locally;
   it does not touch the database and prints no credential material):

   ```powershell
   cd C:\dev\ShiftSync-deploy
   git fetch origin
   git checkout --detach origin/master
   npm install
   npx -y @railway/cli@5.63.1 run npm run vlm:check
   ```

   Expect: `provider=vertex-gemini model=gemini-3.6-flash … region=eu`, then
   `answered by model=… in …ms; tokens in/out=…; shift rows read=4 (expected 4)` and
   `RESULT: PASS`. Exit codes: 0 pass, 1 fail, 2 not configured.
   - `FAIL (credentials)…` → the pasted JSON is incomplete; re-paste the whole file.
   - `FAIL (failed, HTTP 403)` → the service account lacks **Vertex AI User**, or the API isn't enabled.
   - `FAIL (model_unavailable)` → a model/location mismatch; check `GEMINI_VERTEX_LOCATION` is unset or `eu`.
   - `FAIL (busy, HTTP 429)` → the quota from step 2 is too low or exhausted; wait a minute.
2. Deploy the API the documented way ([`railway-deploy-procedure.md`](railway-deploy-procedure.md) §2: `railway redeploy --from-source`, never `railway up`). In the deploy log there must be **no** `[vision] … client setup failed` line.

## 6. Photo-roster test on a phone

1. On a phone, sign in as a manager of a **test venue** (AI reading is limited to once per venue per week, so don't spend a real venue's allowance). Open **Scheduling** → the roster upload panel. It states that image and scanned-PDF rosters are read by a third-party AI service outside the UAE.
2. Take a photo of a printed roster with **made-up names** (or the sample image from `server/scripts/fixtures/vlm-check-roster.png` shown on another screen).
3. The **review screen** must show the shifts read from the photo; nothing is saved until you confirm.
4. Railway logs for that request: `[parseVision] image/PDF read by vertex-gemini model=… — … chars, tokens in/out=…/…, N shifts`. The log carries counts only, never the names.

## 7. Turning it off, rotating the key

- **Off:** delete `GEMINI_VERTEX_PROJECT` (and `GOOGLE_SERVICE_ACCOUNT_JSON`) in Railway, redeploy. Image uploads go back to the clear 422; spreadsheets are unaffected.
- **Rotate:** in Google Cloud, create a new JSON key for `shiftsync-vision`, replace the Railway value, redeploy, run `vlm:check`, then delete the old key under **Keys**.

## Cost

`vlm:check` and every production read log the input/output token counts. Multiply by the current
per-token prices on Google's Vertex AI pricing page for the model in use; prices weren't copied
here because they change.
