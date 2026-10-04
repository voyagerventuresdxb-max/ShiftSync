# Sign-in codes in the UAE: SMS vs WhatsApp

Researched 2026-10-04 from the providers' and Meta's current public pages (sources at the end).
Prices and lead times change, so re-check them before signing anything. Where a figure could
not be verified it says so.

## What exists in the code today

- `SMS_OTP_ENABLED` (off by default) turns on SMS delivery of the code from every request-otp
  route, through Twilio Programmable Messaging (`server/src/lib/sms.ts`). Tests mock the
  provider; nothing has been sent for real. Variables: `docs/ENV_VARS.md`.
- The provider sits behind a small `SmsSender` interface, so swapping Twilio for a UAE
  aggregator means writing one more sender. That matters because of the registration hold
  below.
- No WhatsApp delivery exists yet.

## Side by side

| | SMS (alphanumeric sender ID) | WhatsApp authentication template |
|---|---|---|
| Price per code | Twilio $0.1176 per segment [1]; Plivo $0.0988 (du) to $0.1150 (Etisalat) [2] | Meta's UAE authentication rate $0.0157 [5], plus Twilio's $0.005 per message if sent through Twilio [7]. The higher "authentication-international" rate applies only above 750K codes in 30 days for a business based outside the UAE [6]. |
| Fixed fees | International sender ID: Twilio $225 setup + $115/month [3]; Unifonic $160 + $80/month [4] | None found |
| Registration needed | Yes, on both du and Etisalat [15]. Unregistered sender IDs are blocked [8]. | Meta business verification, a display name and a template review |
| Lead time | Normally: Twilio says 2 weeks [8]; e& says 24–48 hours once filed [9]; an aggregator blog reports 5–10 business days (domestic) and 20–25 (international) [10]. **Now: Twilio has put all new UAE alphanumeric sender ID registrations on hold (page updated 2026-06-15) [3]; Vonage has international-brand registrations on hold but not domestic ones (2026-07-30) [11].** | Business verification 10 minutes to 14 working days [12]; display name 1–2 days [12]; template review up to 24 hours [13] |
| Documents | Domestic: trade licence, Emirates ID, establishment card, passport/visa, NOCs, du Form B. International: certificate of incorporation or licence, signatory ID, form [3] | Business verification documents |
| Message rules | No numeric long or short codes, no links, no phone numbers in the body [8]. Codes count as transactional: e& does not check consent for them [9], and the 9pm–7am ban covers marketing only [18]. | Fixed wording ("… is your verification code") [16]. One-tap/zero-tap autofill needs the Android package name, signing-key hash and a handshake, otherwise a "copy code" button [17]. Unverified businesses are limited to 250 conversations a day [14]. |
| Regulator | TDRA rules for A2P SMS apply | No TDRA restriction on WhatsApp text messages found; TDRA restricts unlicensed VoIP calls only [19] |
| Reach | Every phone | A vendor claims 90% penetration in the UAE [20]; no independent figure could be verified |
| Falls back to the other? | — | Twilio Verify can pick WhatsApp then SMS (pilot) [21]; Vonage tries channels in order [22]; Infobip offers automatic SMS fallback [23]. Meta itself advises against making WhatsApp the only way to get a code [24]. |

## Recommendation

1. **Start SMS sender-ID registration now**, as a domestic registration (it needs a UAE trade
   licence). Twilio's UAE registrations are on hold, so register through a provider that is
   still accepting domestic UAE registrations (Unifonic or Vonage domestic per the pages above;
   confirm before paying) and add a sender for it behind `SmsSender`.
2. **Make WhatsApp the default channel once it is built:** about 5–7× cheaper per code, and no
   carrier registration.
3. **Keep SMS as the fallback** and let the person choose "text me instead", as Meta advises.

**Open question for the owner:** does ShiftSync (or its operating company) hold a UAE trade
licence? Without one only an international registration is possible, which is the route
currently on hold at both Twilio and Vonage.

## Before turning `SMS_OTP_ENABLED` on in production

- The sender ID is approved on both du and Etisalat; one test code reaches a du number and an
  Etisalat number.
- The provider settings are set on Railway (boot is refused without them when the flag is on).
- The existing per-number and global code limits stay as they are: every code is now a paid
  message, and they are the main defence against SMS pumping.
- `ALLOW_DEV_OTP_ECHO` is removed.

## Sources

1. Twilio SMS pricing, UAE — https://www.twilio.com/en-us/sms/pricing/ae
2. Plivo SMS pricing, UAE — https://www.plivo.com/sms/pricing/ae/
3. Twilio support, UAE sender ID registration (updated 2026-06-15) — https://support.twilio.com/hc/en-us/articles/360046382293
4. Unifonic, UAE sender ID registration requirements — https://docs.unifonic.com/articles/products-documentation/uae-sender-id-registration-requirements
5. Twilio WhatsApp pricing details (CSV, "Pricing current as of September 2026") — https://www.twilio.com/content/dam/twilio-com/pricing-data/en/WhatsAppPricing-pricing-details.csv
6. Meta, authentication-international rates — https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/authentication-international-rates/
7. Twilio WhatsApp pricing — https://www.twilio.com/en-us/whatsapp/pricing
8. Twilio SMS guidelines, UAE — https://www.twilio.com/en-us/guidelines/ae/sms
9. e& consent management service policy (PDF) — https://www.eand.ae/en/system/wst/assets/docs/business/general/etisalat-consent-management-service-policy.pdf
10. Message Central, TDRA sender ID approval timelines (aggregator blog, 2026-05-28) — https://www.messagecentral.com/blog/tdra-sender-id-approval-real-timelines
11. Vonage support, UAE sender ID (2026-07-30) — https://api.support.vonage.com/hc/en-us/articles/204017363
12. respond.io, Meta business verification (2026-10-02) — https://respond.io/help/whatsapp/meta-business-verification
13. Meta, message templates overview — https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
14. Meta, messaging limits — https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
15. Infobip, UAE letter of authorization guidelines — https://www.infobip.com/docs/essentials/mena-registration/united-arab-emirates-letter-of-authorization-loa-guidelines
16. Meta, authentication templates — https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates
17. Meta, autofill-button authentication templates — https://developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates/autofill-button-authentication-templates
18. TDRA, cellular phone spam regulatory policy v1.1 (2022-06-13) — https://tdra.gov.ae/-/media/About/regulations-and-ruling/EN/cellular-phone-spam-regulatory-policy-English.ashx
19. TDRA FAQs — https://tdra.gov.ae/en/FAQs
20. Infobip, WhatsApp statistics (vendor claim) — https://www.infobip.com/blog/whatsapp-statistics
21. Twilio Verify, WhatsApp — https://www.twilio.com/docs/verify/whatsapp
22. Vonage Verify, workflows — https://developer.vonage.com/en/verify/concepts/workflow
23. Infobip, WhatsApp OTP — https://www.infobip.com/whatsapp-business/otp
24. Meta, zero-tap authentication templates — https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/zero-tap-authentication-templates
