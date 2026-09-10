# GCP / Vertex AI setup — roster vision-fallback

The roster-upload vision-fallback path (image/scanned-PDF rosters) is fully
coded to use Vertex AI (`server/src/parsing/parseVision.ts`, `getClient()`)
and needs no further code changes once the values below exist — it currently
falls back to the Gemini Developer API (`GEMINI_API_KEY`) for local dev,
which is **not** the EU-data-residency-pinned path this app is meant to run
on in production.

Do this once, in the Google Cloud Console (or `gcloud` CLI, noted per step):

1. **Create (or pick) a GCP project.**
   Console → *New Project*. Note the **Project ID** (not the display name) —
   you'll need it for `GEMINI_VERTEX_PROJECT`.
   `gcloud`: `gcloud projects create <PROJECT_ID>`

2. **Enable billing on the project.**
   Vertex AI is a paid API — it will not enable without an active billing
   account attached.

3. **Enable the Vertex AI API.**
   Console → *APIs & Services → Library* → search "Vertex AI API" → Enable.
   `gcloud`: `gcloud services enable aiplatform.googleapis.com --project=<PROJECT_ID>`

4. **Create a service account for this app.**
   Console → *IAM & Admin → Service Accounts → Create Service Account*.
   Name it something identifiable, e.g. `shiftsync-roster-vision`.
   `gcloud`: `gcloud iam service-accounts create shiftsync-roster-vision --project=<PROJECT_ID> --display-name="ShiftSync roster vision fallback"`

5. **Grant it exactly one role: `Vertex AI User` (`roles/aiplatform.user`).**
   This is the minimal role that can call Gemini generateContent/prediction
   endpoints — it does **not** grant model/endpoint creation, deletion, or
   any other Vertex AI admin capability. Do not grant `roles/aiplatform.admin`
   or `roles/editor` — broader than this app needs.
   Console → on the service account → *Permissions* tab → *Grant Access* →
   paste the service account's own email as the principal → role
   *Vertex AI User*.
   `gcloud`:
   ```
   gcloud projects add-iam-policy-binding <PROJECT_ID> \
     --member="serviceAccount:shiftsync-roster-vision@<PROJECT_ID>.iam.gserviceaccount.com" \
     --role="roles/aiplatform.user"
   ```

6. **Generate a JSON key file for the service account.**
   Console → on the service account → *Keys* tab → *Add Key* → *Create new
   key* → JSON → download.
   `gcloud`: `gcloud iam service-accounts keys create key.json --iam-account=shiftsync-roster-vision@<PROJECT_ID>.iam.gserviceaccount.com`

   **Treat this file as a secret.** Do not commit it to the repo. Store it
   wherever the server's other secrets live (the deployment platform's
   secret manager, or a local `.env`-adjacent path that's gitignored).

7. **Set the 3 values in the server's environment** (`.env` for local dev,
   or the deployment platform's env-var config for production):

   | Variable | Value | Notes |
   |---|---|---|
   | `GEMINI_VERTEX_PROJECT` | the Project ID from step 1 | required — this is what switches `getClient()` from the dev Gemini API fallback to real Vertex AI |
   | `GEMINI_VERTEX_LOCATION` | `europe-west4` | optional — code already defaults to `europe-west4` if unset; set explicitly only to use a different EU region |
   | `GOOGLE_APPLICATION_CREDENTIALS` | absolute path to the JSON key file from step 6 | required for the server process to find its credentials — Application Default Credentials (ADC) picks this up automatically, no other code/config needed |

   If deploying on GCP infrastructure (Cloud Run, GKE with Workload
   Identity, etc.) instead of a VM/container that reads a mounted key file,
   `GOOGLE_APPLICATION_CREDENTIALS` can be omitted entirely — ADC resolves
   the identity from the platform's own workload identity binding instead.
   That's a deployment-target decision or (bind the same service account
   from step 4 to the deployed service).

8. **Verify.** With all 3 vars set, restart the server and upload a real
   image or scanned-PDF roster. Server logs should show a Vertex AI call
   (no `GEMINI_API_KEY not configured` / Gemini Developer API fallback
   warning in `parseVision.ts`'s console output). If it fails, the error
   message from `getClient()`/the SDK will say which of the 3 values is
   missing or rejected.

## Cost note

Vertex AI Gemini calls are billed per request/token, separate from Google
Workspace/other GCP spend already on this project (if any). The app's own
`server/src/routes/schedules.ts` already rate-limits this path to one
vision-fallback parse per venue per week and caps uploads at 5MB, which
bounds worst-case spend — this doc doesn't change that.
