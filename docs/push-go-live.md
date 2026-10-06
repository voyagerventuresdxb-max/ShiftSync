# Push notifications go-live (VAPID)

How to switch on Web Push for the live site, check it works on a real phone, and switch it
off again. Written 2026-10-02. **Applied on 2026-10-06 (run 12):** a pair generated with the
script (§1), the three variables set on Railway with `VAPID_SUBJECT` set to the production web
address (`https:`), and the API redeployed; the §4 checks passed. Push is on. §5, the real-phone
test, is still to do.

Without VAPID keys the app already works: every notification is still recorded and shows
under the bell at the top of the app. Push only adds the alert on the phone's lock screen.

## 0. Before you start

1. The API must be running a `master` commit that contains PR #63 and this PR. Older code
   crash-loops on a bad VAPID value and accepts a public and private key from two different
   pairs, which pass every check but never deliver. Check Railway → `shiftsync-api` →
   Deployments: the active deployment's commit must be at or after the merge of this PR. If
   it isn't, deploy `master` first ([railway-deploy-procedure.md](railway-deploy-procedure.md) §2).
2. Pick a time outside venue service hours. Applying the variables redeploys the API, and
   the uploads volume means about 3 minutes of downtime
   ([railway-deploy-procedure.md](railway-deploy-procedure.md) §1.4).
3. Note the ID of the deployment that is serving now (Deployments tab), for rollback.

## 1. Generate the key pair

1. On your own machine, in an up-to-date checkout of `master`, run:
   ```
   npm run vapid:generate
   ```
2. It prints `VAPID_PUBLIC_KEY=…` (87 characters, starts with `B`), `VAPID_PRIVATE_KEY=…`
   (43 characters) and a `VAPID_SUBJECT=mailto:…` placeholder to the terminal. It saves
   nothing, reads no `.env` and calls nothing. Every run prints a different pair.
3. Copy both keys **from the same run**. Halves of two runs don't fit together, and the API
   refuses them (`VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY`).
4. The private key is a secret. Never commit it, and never put it in `.env.example`, docs,
   chat, tickets or screenshots. Railway's variable editor is where it lives. If you want a
   backup, use a password manager. Close the terminal when you're done.
5. One pair per environment. Production gets its own. A `deploy-check` environment (§3.1 of
   the procedure) gets a different pair, or none.

## 2. Set the variables on Railway

1. Railway dashboard → the ShiftSync project → **production** environment → `shiftsync-api`
   → **Variables**.
2. Add three variables (names exactly as written):

   | Name | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | the public key from step 1 |
   | `VAPID_PRIVATE_KEY` | the private key from the same run |
   | `VAPID_SUBJECT` | `mailto:` followed by an inbox the team reads, e.g. `mailto:ops@<your domain>`. An `https:` URL also works, but not a `localhost` one (Apple's push service rejects it). Push services use it to contact you about problems. |

   `VAPID_SUBJECT` must start with `mailto:` or `https:`. Don't leave it out: the code then
   falls back to a placeholder address nobody reads. Set but empty, push stays off.
3. Railway stages the change and shows a banner. Nothing is live yet.

## 3. Redeploy

1. Apply the staged change with the **Deploy** button in Railway's banner. That redeploys
   the API with the new variables. Expect about 3 minutes of downtime.
2. **Never run `railway up`** for this (#52). Follow
   [railway-deploy-procedure.md](railway-deploy-procedure.md) §2 for the deploy itself and
   its build-log checks.

## 4. Verify

1. **Deploy log.** It must contain `ShiftSync API listening on …` and must **not** contain
   `push notifications are disabled`. That phrase ends both failure lines:
   - `[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled.`
     A key variable is missing or misspelled.
   - `[push] VAPID config rejected (<reason>) — push notifications are disabled.` The reason
     says what is wrong:

     | Reason | Fix |
     |---|---|
     | `Vapid subject is not a valid URL. <VAPID_SUBJECT>` or `… not an https: or mailto: URL` | `VAPID_SUBJECT` lacks `mailto:`/`https:`, or holds something else. The log never prints its value. |
     | `No subject set in vapidDetails.subject.` | `VAPID_SUBJECT` exists but is empty |
     | `Vapid public key should be 65 bytes long …` / `must be a URL safe Base 64 …` | public key truncated, quoted or with extra characters, or the two keys swapped |
     | `Vapid private key should be 32 bytes long …` / `must be a URL safe Base 64 …` | same, for the private key |
     | `VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY` | keys from two different runs. Generate once more and paste both from that run. |

   The API keeps serving either way. Fix the variable and deploy again.
2. **Public key endpoint**, through Vercel (what browsers use) and on Railway directly:
   ```
   curl -s https://shift-sync-two-ashy.vercel.app/api/push/vapid-public-key
   curl -s https://shiftsync-api-production.up.railway.app/api/push/vapid-public-key
   ```
   Both must print `{"publicKey":"B…"}`, where the key is 87 characters and the same value as
   `VAPID_PUBLIC_KEY`. The public key isn't secret. `{"publicKey":""}` means push is still
   off, so go back to 4.1. HTML instead of JSON is the #52 signature: roll back (§7).
3. **Vercel needs nothing.** The frontend fetches the public key from
   `/api/push/vapid-public-key` at runtime. There is no build variable and no redeploy.

## 5. Test on a real phone

You need two accounts at the same venue. **A** receives on the phone. **B** triggers from a
laptop. For example, A is a staff member and B is the owner.

### Android (Chrome)

1. On the phone, open `https://shift-sync-two-ashy.vercel.app` in Chrome and sign in as A.
   A normal browser tab is enough. Installing isn't needed.
2. Tap **People** in the bottom bar and scroll to **Notification preferences**. Tap
   **Enable notifications**, then **Allow** in Chrome's prompt. The panel now says *Push
   notifications are on for this device.*
3. Lock the phone or switch apps.
4. On the laptop, as B: **Home → Announcements → Post**, type a line, tap **Broadcast**.
5. Within seconds the phone shows **New announcement** with your text as the body. Tapping it
   opens ShiftSync. The same item appears under A's bell.

### iPhone (iOS / iPadOS 16.4 or later)

Web Push on iPhone only works in a web app added to the Home Screen, never in a Safari tab.

1. In Safari, open `https://shift-sync-two-ashy.vercel.app`, tap **Share → Add to Home
   Screen**, then open ShiftSync **from the Home Screen icon**.
2. Sign in as A again. The Home Screen app doesn't share Safari's sign-in.
3. Continue from Android step 2. iOS shows its own **Allow** prompt.
4. The web app manifest and icons are on master (`public/manifest.webmanifest`, linked from
   `index.html`), so the Home Screen icon opens as an app. If it ever opens as a plain Safari
   page instead (Safari's address bar visible, and the panel says *Push notifications aren't
   supported in this browser.*), remove the icon and add it again from Safari.

### Other real triggers

Every one of these goes through `notifyUser`, so it also lands under the bell:

| Action (who does it) | Who gets it | Title |
|---|---|---|
| Home → Announcements → Post → Broadcast (anyone) | everyone at the venue except the poster | New announcement |
| Home → Shoutouts → pick A and one of A's shifts → Give shoutout (anyone but A) | A | You got a shoutout! |
| Scheduling → **Publish & notify** / **Publish changes** (manager) | each staff member with a shift that week | Schedule updated |
| Floor plan → **Publish & notify** (manager) | each staff member assigned a section | New section assignment |
| A swap request (staff) | every manager and the owner | New swap request |
| Approving or declining that swap (manager) | the requester (and the covering colleague on approval) | Swap request approved / declined, You were added to a shift |
| Someone new submits a join request from the venue join link | every manager and the owner | New join request |
| A manager reviews floor feedback | the person who sent it | Feedback update |

Approving a join request sends nothing. The applicant has no account until then.

### Troubleshooting

- **"Notifications are blocked for this site…"**: permission was denied. On Android, open
  Chrome's site settings for ShiftSync (the icon left of the address) → Notifications →
  Allow. On iPhone, go to Settings → Notifications → ShiftSync → Allow Notifications. Then
  reload ShiftSync and tap **Enable notifications** again.
- **iPhone shows no prompt, or says "not supported"**: you're in a Safari tab, or the Home
  Screen icon opened as a Safari page (see iPhone step 4 above).
- **Incognito or private window**: Chrome turns the Push API off there. The panel then says
  notifications are blocked, or answers *Could not enable push notifications.* Use a
  normal window.
- **"Push notifications aren't switched on for ShiftSync yet."**: the API has no valid
  VAPID config. Go back to §4. (A frontend deployed before this PR shows **Enable
  notifications** instead and answers *Push is not configured for this venue yet.*)
- **On, but nothing arrives**: look in the API log for
  `[push.send] failed for subscription <id>`. Check that the phone isn't in Focus / Do Not
  Disturb, and on Android that Chrome isn't battery-restricted. Then try **Turn off →
  Enable notifications**.
- **After a key rotation**: every existing subscription belongs to the old key. Each device
  has to tap **Turn off**, then **Enable notifications**. Until then, sends to it fail and
  are logged as `[push.send] failed for subscription <id>`. They aren't removed
  automatically, because only "gone" answers (404/410) prune a subscription.

## 6. Rotating the keys

Rotate only if the private key leaks or is lost. Run step 1 again, replace **both** values
in Railway, and redeploy (§3). Then tell everyone to turn notifications off and on again on
each device (§5 troubleshooting).

## 7. Rollback

- **Switch push off:** delete the three `VAPID_*` variables on `shiftsync-api` and deploy
  the staged change (about 3 minutes of downtime). The log then shows
  `[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled.`
  The app keeps working: the bell still records everything, and People shows *Push
  notifications aren't switched on for ShiftSync yet.* Saved subscriptions stay in the
  database. They work again if the **same** pair is restored. A new pair needs the off/on
  toggle.
- **Bad deploy:** Railway → Deployments → the deployment you noted in §0 → **Rollback**. That
  restores its variables too ([railway-deploy-procedure.md](railway-deploy-procedure.md) §4).
