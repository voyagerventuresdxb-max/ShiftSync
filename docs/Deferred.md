# Deferred / Next-Sprint Items

Logged architectural gaps and known issues, not yet actioned.

## Bugs
- **Shift ID uniqueness bug** — currently unique only within a single upload batch. Risk of silent data loss across multiple uploads. **Fix priority: high.**
- **No GET endpoint to reload confirmed schedule data** — schedule view only populates correctly immediately after confirm, same browser session. Needs a proper reload endpoint.

## Known Gaps
- Multi-outlet single-file rosters — not yet supported
- Legend-code shift systems — not yet supported
- Bilingual Arabic/English or days-as-rows layouts — currently falls through to an unplanned Gemini call (needs a real handling path)
- Missing Dubai fine-dining role vocabulary in `ROLE_ALIASES`: Chef de Rang, Commis de Salle, Outlet Manager

## On the Horizon (Product)
- Complete Phase 2 of Lovable-to-Antigravity integration (Announcements, Shoutouts, Conflict-Free Approvals)
- Proceed to remaining integration phases after Phase 2
- Complete native rota builder (top priority feature)
- Pilot testing: 3–5 sessions, Dubai venue managers, silent observation format — key question: what would they cancel to make room for ShiftSync
- Potential future scope: SevenRooms/reservation platform integration as ops-layer expansion (moat is cultural fit, not feature bundling — watch SevenRooms/Toast encroachment)

---
*Related: [[Home]] · [[MEMORY]] · [[Decisions]]*
