# Floor sections

A floor section is a named area of the venue (Terrace, Bar, Main floor) that staff are put on for a shift. Each one is a pin on the venue's uploaded floor plan, with a name and a pax capacity.

## Where sections are set up

Only on the **Floor plan** page, by an owner or manager: upload the plan (PDF, PNG or JPG), tap the plan where a section sits, name it. Onboarding does not set up sections.

With no sections yet, the Floor plan page shows managers **Add your first section** (upload the plan first if there is none, then place and name a section) and shows staff that their manager hasn't set up the floor plan yet.

## The onboarding stepper (removed 2026-10-07)

The Venue step used to have a **Floor sections** stepper (1 to 12, default 3) with **Set up later**. It saved nothing:

- Continue sent only the venue name, venue type and city (`PATCH /api/locations/:id`).
- `Location` has no section-count field, and a section can't exist without an uploaded plan image, so there was nothing a number could create.

The stepper is gone. The Venue step now says sections are set up later on the Floor plan page. No data was changed.

## What reads floor sections

- **Floor plan page**: the Sections editor and the Daily Assignment board, through `/api/floor-plan` (`server/src/routes/floorPlan.ts`).
- **Scheduling, personal rota**: the "You're covering: …" line, from published assignments (`/api/floor-plan/:locationId/my-assignments`).
- **Voice**: "assign … to Terrace" (`ASSIGN_SECTION`) matches the spoken name against the venue's section names, and the names are hints for transcription.
- **Test-venue cleanup**: deletes them with the venue.

With no sections, none of these break: the rota shows no "You're covering" line, and voice answers a section assignment with "section not found" instead of acting. Real names (Terrace, Bar) also work better by voice than numbers, which is why a new section starts with an empty name and examples rather than "Section 3"; one left blank is still saved as the next free "Section N".
