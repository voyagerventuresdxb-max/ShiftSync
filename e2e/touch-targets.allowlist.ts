/**
 * Documented exceptions to the 44x44 CSS px effective hit-area rule enforced
 * by e2e/touch-targets.spec.ts. Every entry is a category (b) (needs a
 * product/design decision) or (c) (needs visual confirmation) finding from
 * the 2026-09-28 touch-target audit — NOT a target that was forgotten.
 * Remove an entry once its decision is made and implemented, and the spec
 * will start enforcing that element.
 *
 * Match = the element's accessible label (aria-label, else visible text,
 * else placeholder / `input[type]`) tested against `label`, optionally
 * narrowed by `route` (pathname prefix). Keep reasons to one line.
 */
export interface TouchTargetException {
  /** Regex tested against the element's label (see spec's `labelOf`). */
  label: RegExp;
  /** Optional pathname prefix the exception applies to; omit for everywhere. */
  route?: string;
  /** Optional tag restriction, e.g. 'input'. */
  tag?: string;
  category: 'b' | 'c';
  reason: string;
}

export const TOUCH_TARGET_EXCEPTIONS: TouchTargetException[] = [
  // ---- (b) native form controls: ::after cannot apply to replaced elements ----
  { label: /.*/, tag: 'input', category: 'b', reason: 'native <input> (38px): reaching 44px needs a min-height/padding change, i.e. a visual decision' },
  { label: /.*/, tag: 'select', category: 'b', reason: 'native <select> (28–36px): same as inputs — visual min-height decision' },
  { label: /.*/, tag: 'textarea', category: 'b', reason: 'native <textarea>: same as inputs' },

  // ---- (b) RadialDock: transform-scaled buttons + keystone overlaps the focused tab ----
  { label: /^(Home|Scheduling|Floor plan|People)$/, category: 'b', reason: 'RadialDock tabs are h-10 w-10 scaled 0.86–1.02 by transform (34–41px): a ::after scales with them; the focused tab already touches the keystone. Needs a dock-specific hit box (design decision).' },
  { label: /voice command|microphone permission/i, category: 'b', reason: 'RadialDock keystone (40x40) sits over the focused tab; expanding either overlaps the other (z-order priority is a design call)' },

  // ---- (b) neighbouring targets whose expanded 44px areas would overlap ----
  { label: /^(Edit|Delete) announcement$/, category: 'b', reason: '28x28 pair with a 6px gap: expansions overlap each other' },
  { label: /^Next week$/, category: 'b', reason: 'wraps under "Publish" at 390px with a 13px gap: expansions overlap by 1px (and the header itself overflows — see (c))' },
  { label: /^Publish (& notify|changes)$/, route: '/scheduling', category: 'b', reason: 'same wrapped-row overlap with "Next week" in the RotaBuilder header' },
  { label: /^Add shift on /, category: 'b', reason: 'rota grid cell with a shift chip 4px above: expansion would steal the chip\'s bottom edge (hit-44 IS applied on empty cells)' },
  { label: /^\d{2}:\d{2}–\d{2}:\d{2}$/, category: 'b', reason: 'rota grid shift chips (87x23) stack 4px apart above the add button: dense grid, needs a row-height decision' },
  { label: /^.+ \d+ · \d+ shifts?$/, route: '/scheduling', category: 'b', reason: 'RotaBuilder department toggles (#42, 30px) sit 6px above the first row\'s empty-cell add buttons, whose hit-44 reaches into the toggle: z-order/row-height decision' },
  { label: /^Mark all read$/, category: 'b', reason: '78x16 text link 8px above the first notification row' },
  { label: /^(Log in|Join instead)$/, category: 'b', reason: 'two 16px inline text links side by side in the Account step footer' },
  { label: /^Sign up your restaurant$/, route: '/login', category: 'b', reason: 'pre-existing 15px inline footer link, first measured when /login joined this gate (login links); sizing is a design call' },
  { label: /^(Remove|Notify|Re-notify) /, route: '/floor-plan', category: 'b', reason: 'SectionDetail assignee row: 28x28 Remove sits above the 15px Notify text button' },
  { label: /^(Add duty…|Expo)$/, route: '/floor-plan', category: 'b', reason: 'duty-label button uses `truncate` (overflow hidden): its own ::after would be clipped; needs a wrapper' },
  { label: /^Section \d+,/, route: '/floor-plan', category: 'b', reason: 'section pins (~57x44 at 390px) overlap their neighbours in dense clusters at 1x; zoom separates them (e2e/floor-plan-pins.spec.ts crowding test)' },
  { label: /^[A-Z]{2} /, route: '/floor-plan', category: 'b', reason: 'roster-strip staff chips (38px): the strip is overflow-x:auto so a vertical expansion is clipped; needs strip padding (layout)' },
  { label: /^(Fine Dining|Bar \/ Lounge|Nightclub|Rooftop \/ Beach Club|Hotel F&B Outlet|Café \/ Bakery)$/, route: '/onboarding', category: 'b', reason: 'venue-type chips (35px) wrap into rows 8px apart: expansions overlap; locked prototype spacing' },
  { label: /^(Fewer|More) sections$/, route: '/onboarding', category: 'b', reason: 'stepper pair 36x36 with a 6px gap: expansions overlap' },
  { label: /^Skip intro$/, route: '/onboarding', category: 'b', reason: '14px text link 14px under the carousel CTA' },
  { label: /^(Remove|Looks right|Done|\+ Custom|[A-Za-z ]+)$/, route: '/onboarding/review', category: 'b', reason: 'Review row editor: 27px role chips wrap 6px apart inside an overflow:hidden panel; Remove/Looks right sit within 14px of them' },
  { label: /^Cancel$/, route: '/scheduling', category: 'b', reason: 'PersonalRota cover-request Cancel wraps under the substitute <select> at 390px' },
  { label: /^Back on$/, route: '/floor-plan', category: 'b', reason: '86-list rows 6px apart: 26px "Back on" buttons would overlap each other' },
  { label: /^(COPY|SAVE AS IMAGE)$/i, route: '/onboarding/invite', category: 'b', reason: 'measured (a) in one capture and (b) in another depending on the wrapped layout; hit-44 applied, exception kept until confirmed on a device' },

  // ---- (c) needs visual confirmation ----
  { label: /^(Templates \(\d+\)|Save as template)$/, category: 'c', reason: 'RotaBuilder header overflows its overflow-hidden panel at 390px (button visibly cut off) — issue #45' },
  { label: /^WEEKLY ROTA BUILDER/, category: 'c', reason: 'same overflowing RotaBuilder header (the card toggle spans the cut-off row) — issue #45' },
];

/** Same shape for canvas hit regions we deliberately do not measure yet. */
export const EXCLUDED_SELECTORS = ['canvas', '.konvajs-content *'];
