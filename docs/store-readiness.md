# App Store / Google Play readiness

What to verify before the first store upload, with what ShiftSync already does. Researched
2026-10-04 from Apple's and Google's own pages (sources at the end). The quotes were gathered
through a summarising fetch, so **check each one against the live page before relying on it**.
Nothing here is legal advice.

## 1. Account deletion — built in-app

| Requirement | Source | ShiftSync today |
|---|---|---|
| Apple 5.1.1(v): "If your app supports account creation, you must also offer account deletion within the app." | [A1] | **Profile → Delete account** (two-step confirm). `DELETE /api/identity/account`. |
| Apple: "Only offering to temporarily deactivate or disable an account is insufficient." Google: "Temporary account deactivation, disabling, or 'freezing' … does not qualify as account deletion." | [A2], [G1] | Not a deactivation: name, phone, email, job title, language and ID numbers are erased; sessions, login links, push subscriptions, notifications, voice transcripts and sign-in codes are deleted; the person's join-request records are de-identified. |
| Apple: delete "any data associated with the account that the developer isn't legally required to maintain." Google: may "retain certain data for legitimate reasons such as security, fraud prevention or regulatory compliance" and "must clearly inform users". | [A2], [G2] | Kept, de-identified ("Deleted user"): past shifts, attendance, swaps — the venue's employment records. Kept: the audit trail (one `ACCOUNT_DELETED` row, no personal details in it). **To verify with counsel:** which retention the UAE labour rules require, and for how long; state it in the privacy policy. Whether anonymisation counts as deletion is not stated by either store — not verifiable from their pages. |
| Apple: "Inform the user how long it will take … and provide a confirmation when the deletion has been completed." | [A2] | Immediate; the confirm step says so; afterwards `/login` shows "Your account has been deleted." |
| Apple: may verify identity first (e.g. a code to the phone on file). | [A2] | The signed-in session is the verification today. Optional: ask for a fresh code before deleting. |
| Google: also "a web link resource where users can request app account deletion", functional, naming the app/developer, deletion path "prominently featured". | [G2] | **To do:** a public page (e.g. `/delete-account`) explaining the in-app path and a request route for people who no longer have the app; enter its URL in Play Console. |
| A venue's **last active owner** | — | Refused with advice ("make another manager an owner first, or contact support to close the venue"), so a venue is never left ownerless. |

## 2. Privacy disclosures — drafts in place

- Apple 5.1.1(i): a privacy policy link "in the App Store Connect metadata field and within the app in an easily accessible manner"; it must "explain its data retention/deletion policies" [A1]. Google: "an active, publicly accessible and non-geofenced URL (no PDFs)", linked in Play Console and in the app [G1].
  **ShiftSync:** `/privacy` and `/terms`, **clearly labelled DRAFT — needs legal review — not yet in force**, linked from `/login` and the join screen (and from Profile → Delete account). Placeholders in [brackets] are for counsel.
- Apple privacy "nutrition label" types that apply: Name, Phone Number, Audio Data (voice commands), Photos (roster photos), Product Interaction, User ID; crash data if a crash reporter is added [A3]. "Collect" = sent off the device and kept longer than needed to serve the request [A3].
- Google Data safety types: Name, Phone number, Photos, Voice or sound recordings, App interactions, User IDs [G3]. The form asks whether users can request deletion (yes, in-app) and about encryption in transit (HTTPS throughout).
- **To verify:** whether Gemini / Vertex AI counts as a "service provider" (Google's exemption for processing "on behalf of the developer") or as sharing [G3]; staff names and numbers entered *by a manager* (data about other people) — not addressed directly by either store; safer to declare them.

## 3. Third-party AI — explicit consent

- Apple 5.1.2(i) (added 2025-11-13): "You must clearly disclose where personal data will be shared with third parties, including with third-party AI, and obtain explicit permission before doing so." 5.1.1(ii): an "easily accessible and understandable way to withdraw consent" [A1], [A5].
- Google: no AI-specific rule found; the prominent-disclosure rule applies when a use is outside "the reasonable expectation of the user", with consent by "affirmative user action" [G1].
- **ShiftSync:** roster photos/scans go to the AI reader only after the manager agrees, per file (the consent step in the roster-escalation PR). **To do:** the same explicit opt-in before the first voice command (audio goes to Gemini), with a settings toggle to withdraw; a manual alternative exists for both (Excel/CSV or "add staff by hand"; buttons instead of voice).

## 4. "Wrapped website" rejection risk

- Apple 4.2: apps must "include features, content, and UI that elevate it beyond a repackaged website"; 4.2.2: not "primarily … web clippings, content aggregators, or a collection of links" [A1]. Apple names no specific native features.
- Google: no apps that "do not have the basic degree of adequate utility as mobile apps" or are "static without app-specific functionalities" [G5]; the WebView-of-someone-else's-site rule [G4] doesn't apply (we own the site).
- Not official (developer reports): useful native push, biometrics and a designed offline screen help Capacitor apps pass review [N1], [N2].

**Native-feature plan (Capacitor shell, `docs/android.md`):**
1. Native push (Capacitor Push Notifications → FCM/APNs) for rota published, cover requests, approvals — Web Push doesn't work inside the WebView.
2. Camera capture for roster photos (Capacitor Camera / the system photo picker — Google: request `READ_MEDIA_IMAGES` only if system pickers are not enough [G6]).
3. Offline: cached My Shifts / this week's rota with an "offline, last updated …" label (planned).
4. App Links so invite and login links open the app; secure token storage (Keystore/Keychain) before release.
5. Optional: biometric unlock of the stored session.

## 5. Android release mechanics

- Target SDK: "New apps and app updates must target Android 16 (API level 36) or higher" from 2026-08-31, extensions "to November 1, 2026" [G7]. The shell already targets API 36 (`android/variables.gradle`: `compileSdkVersion`/`targetSdkVersion` 36; the debug-APK workflow installs `platforms;android-36`).
- New personal developer accounts: a closed test with "a minimum of 12 testers … for at least 14 days" before production [G8].

## Checklist before the first upload

- [ ] Counsel reviews and finalises `/privacy` and `/terms` (entity, jurisdiction, UAE PDPL wording, retention periods) and removes the DRAFT banner.
- [ ] Public account-deletion web page for Play Console (§1).
- [ ] Explicit voice opt-in + withdraw toggle (§3).
- [ ] Apple privacy labels and Play Data safety form filled from §2.
- [ ] Native push, camera picker, offline screen in the shell (§4); App Links; secure token storage.
- [ ] Play: target API 36, closed test (12 testers × 14 days) if the account is personal.

## Sources

- [A1] https://developer.apple.com/app-store/review/guidelines/
- [A2] https://developer.apple.com/support/offering-account-deletion-in-your-app/
- [A3] https://developer.apple.com/app-store/app-privacy-details/
- [A5] https://developer.apple.com/news/?id=ey6d8onl (2025-11-13)
- [G1] https://support.google.com/googleplay/android-developer/answer/10144311
- [G2] https://support.google.com/googleplay/android-developer/answer/13327111
- [G3] https://support.google.com/googleplay/android-developer/answer/10787469
- [G4] https://support.google.com/googleplay/android-developer/answer/9899034
- [G5] https://support.google.com/googleplay/android-developer/answer/9898783
- [G6] https://support.google.com/googleplay/android-developer/answer/14115180
- [G7] https://support.google.com/googleplay/android-developer/answer/11926878
- [G8] https://support.google.com/googleplay/android-developer/answer/14151465
- [N1] (not official) https://forum.ionicframework.com/t/apple-4-2-minimum-functionality/189688
- [N2] (not official) https://dev.to/batmanofweb/apple-rejected-your-lovable-app-under-42-now-what-1d0e
