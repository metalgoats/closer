// How a Fathom recording gets its label in the inbox (TASK-082).
//
// Extracted into its own module so the rules are unit-testable — the first version of this
// change would have renamed two different calls ("Kyle" and "Evette") to the same string,
// "Impromptu Zoom Meeting", and only a dry run caught it.

// Titles conferencing tools invent when nobody names the meeting. They identify nothing, and
// several calls share them verbatim, so an attendee's name beats them every time.
const GENERIC_TITLE = new RegExp(
  "^(" +
    "(impromptu |instant |new |my |personal |untitled )*" +
    "(zoom|google ?meet|meet|microsoft teams|teams|webex|skype|huddle|conference)?" +
    " ?(meeting|call|room|huddle)?" +
  ")$|" +
  "^untitled\\b|" +
  "'s (zoom |personal )?(meeting|meeting room)$|" +   // "Dana's Zoom Meeting"
  "^meeting with$",
  "i"
);

export function isGenericTitle(title) {
  const t = String(title || "").trim().replace(/\s+/g, " ");
  if (!t) return true;
  return GENERIC_TITLE.test(t);
}

export function deriveAttendeeName(m) {
  const ext = (m?.calendar_invitees || []).find(i => i.is_external && i.name);
  return ext?.name?.trim() || null;
}

// The meeting title is the label — it is what the call is actually called ("OSA Sales
// Training"), and preferring an attendee made real calls unrecognisable. But a generic
// auto-title is worse than a person's name, so fall back in that case.
export function deriveClientName(m) {
  const title = String(m?.meeting_title || m?.title || "").trim();
  const attendee = deriveAttendeeName(m);
  if (title && !isGenericTitle(title)) return title;
  return attendee || title || "Untitled call";
}
