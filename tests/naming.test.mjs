// TASK-082: what a Fathom recording is called in the inbox.
//
// Why this file exists: the first cut of this change simply preferred the meeting title over
// the attendee. A dry run against production showed it would rename TWO different calls —
// "Kyle" and "Evette" — to the same string, "Impromptu Zoom Meeting", leaving them
// indistinguishable in the list. A generic auto-title is worse than a person's name.
import { deriveClientName, deriveAttendeeName, isGenericTitle } from "../src/naming.js";

let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

const meeting = (title, attendee) => ({
  meeting_title: title,
  calendar_invitees: attendee ? [{ name: attendee, is_external: true }] : []
});

console.log("\n== a real title wins over an attendee (the actual bug) ==");
check("'OSA Sales Training' beats attendee 'Nathan Macias'",
  deriveClientName(meeting("OSA Sales Training", "Nathan Macias")) === "OSA Sales Training");
check("'On-Screen Authority VIP Studio Call x Pam' beats 'Jeff Velastegui'",
  deriveClientName(meeting("On-Screen Authority VIP Studio Call x Pam", "Jeff Velastegui")) === "On-Screen Authority VIP Studio Call x Pam");

console.log("\n== but a generic auto-title never does ==");
// Every one of these is a default invented by the conferencing tool. Several calls share them
// verbatim, so using them as the label makes distinct calls look identical.
for (const t of ["Impromptu Zoom Meeting", "Zoom Meeting", "New Meeting", "Meeting", "meeting",
                 "Untitled", "Untitled Meeting", "Google Meet", "Microsoft Teams Meeting",
                 "Huddle", "Instant Meeting", "My Meeting", "Dana's Zoom Meeting",
                 "Kyle's Personal Meeting Room", "  Zoom   Meeting  ", ""]) {
  check(`"${t}" is treated as generic`, isGenericTitle(t));
}
check("Kyle keeps his name, not 'Impromptu Zoom Meeting'",
  deriveClientName(meeting("Impromptu Zoom Meeting", "Kyle")) === "Kyle");
check("Evette keeps hers too", deriveClientName(meeting("Impromptu Zoom Meeting", "Evette")) === "Evette");
check("two generic-titled calls stay DISTINCT",
  deriveClientName(meeting("Impromptu Zoom Meeting", "Kyle")) !==
  deriveClientName(meeting("Impromptu Zoom Meeting", "Evette")),
  "both would collapse to the same label");

console.log("\n== real titles are not mistaken for generic ==");
for (const t of ["Sales Meeting with Acme", "Weekly Meeting — Growth", "OSA Sales Training",
                 "Andrelle Stanley X Gabriel Galindo", "Meeting Prep: Q3", "Zoom Integration Review",
                 "Sangha Sundays +  Q&A Yoga Mārga School"]) {
  check(`"${t}" is NOT generic`, !isGenericTitle(t));
}

console.log("\n== fallbacks ==");
check("no title at all -> attendee", deriveClientName(meeting("", "Marcus Webb")) === "Marcus Webb");
check("no title and no attendee -> a safe placeholder", deriveClientName(meeting("", null)) === "Untitled call");
check("generic title and no attendee -> keep the generic title over nothing",
  deriveClientName(meeting("Zoom Meeting", null)) === "Zoom Meeting");
check("whitespace-only title is not used", deriveClientName(meeting("   ", "Marcus")) === "Marcus");
check("undefined input does not throw", deriveClientName(undefined) === "Untitled call");

console.log("\n== attendee extraction ==");
check("picks the external invitee", deriveAttendeeName(meeting("t", "Marcus")) === "Marcus");
check("ignores internal invitees",
  deriveAttendeeName({ calendar_invitees: [{ name: "Gabriel", is_external: false }] }) === null);
check("no invitees -> null", deriveAttendeeName({}) === null);

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
