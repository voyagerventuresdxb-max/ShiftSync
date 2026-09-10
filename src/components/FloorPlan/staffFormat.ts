/** Two-letter avatar initials, e.g. "Andrea Rossi" -> "AR". */
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** First name only, for compact pin/chip labels. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Compact pin label from a section's free-text label, e.g. "Section 1 — Terrace West" -> "Sec 1". Falls back to the label's first word for a venue-chosen name with no leading number. */
export function sectionPinName(label: string): string {
  const match = label.match(/^Section\s+(\d+)/i);
  if (match) return `Sec ${match[1]}`;
  return label.split(/\s+/)[0] ?? label;
}
