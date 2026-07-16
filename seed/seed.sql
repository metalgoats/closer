-- Dev seed: the On Screen Authority account, template, and demo calls.
-- Scoped to OSA only as of 2026-07-16 (hypnotherapy removed from scope, TASK-030).
-- Run: npm run db:seed:local  (dev only — never against production)

INSERT INTO accounts (id, name, llm_provider) VALUES
  (1, 'On Screen Authority', 'anthropic');

INSERT INTO integrations (account_id, kind, status, secret_name) VALUES
  (1, 'fathom', 'disconnected', 'FATHOM_API_KEY_OSA'),
  (1, 'anthropic', 'disconnected', 'ANTHROPIC_API_KEY'),
  (1, 'ghl', 'disconnected', 'GHL_OAUTH');

-- Master debrief prompt per account (full text lives in the repo's PROMPT.md; body here is
-- what actually gets sent). Seeded identical for both accounts; they diverge from here.
INSERT INTO prompt_templates (account_id, tone, version, body, active) VALUES
  (1, NULL, 1, 'You are a world-class sales performance coach... (paste full master prompt via Prompt Template screen)', 1);

INSERT INTO calls (id, account_id, client_name, occurred_at, duration_min, source, outcome, suggested_tone, tone_reason, selected_tone, processed_at, debrief_json, transcript) VALUES
(1, 1, 'Jeffrey R.', datetime('now', '-3 hours'), 38, 'fathom', 'closed', 'formal', 'High-ticket VIP client, formal language throughout the call', 'formal', datetime('now', '-2 hours'),
'{"scorecard":[["Rapport",8],["Authority",9],["Trust",8],["Emotional Connection",6],["Pain Amplification",7],["Vision Building",8],["Objection Handling",7],["Certainty Transfer",9],["Close Attempt",9],["Follow-up Positioning",8]],"didWell":["Opened with authority — walked Jeffrey through exactly what happens after signing before he had to ask.","Used assumptive language once buying signals appeared.","Closed cleanly and did not over-explain after he said yes — let the silence sit."],"hurtSale":["Spent ~4 minutes on VIP feature specs before any pain was established — logic before emotion.","Answered the pricing question directly instead of isolating it first.","Missed a chance to loop back on ''my team''s going to need convincing''."],"objections":[{"said":"I just want to make sure my team can actually use this.","meant":"He''s worried about championing a tool that flops internally.","felt":"Fear of looking foolish in front of his staff.","should":"What would it feel like walking into your next team meeting having already solved this for them?","follow":"Who on your team tends to push back on new tools — and what usually wins them over?","loop":"Return to this after the onboarding walkthrough to reinforce it''s a solved problem."}],"profile":["Values hierarchy: status and team perception rank above price.","Decision speed: fast once authority and certainty are established.","Trust triggers: specificity and process clarity.","Likely DISC: high D/C."],"buyingSignals":["Asked about staff invitations before being pitched on it.","Used ''once'' language well before the close.","False signal: ''sounds good'' mid-pitch was politeness — flat tone."],"lessons":["With high-D/C prospects, lead with process clarity — it is the rapport.","Isolate price objections before answering them.","A one-line team objection is never a throwaway — loop back before the close."]}',
'0:02 — Gabriel: Jeffrey, great to see you...'),

(3, 1, 'Priya K.', datetime('now', '-1 day'), 29, 'fathom', 'followup', 'balanced', 'Mixed formality — warm early, more guarded once spouse came up', 'balanced', datetime('now', '-1 day'),
'{"scorecard":[["Rapport",7],["Authority",7],["Trust",6],["Emotional Connection",6],["Pain Amplification",6],["Vision Building",6],["Objection Handling",5],["Certainty Transfer",5],["Close Attempt",6],["Follow-up Positioning",7]],"didWell":["Stayed calm and non-pushy when the spouse objection came up.","Recapped value clearly before ending the call."],"hurtSale":["Did not isolate the spouse objection — accepted it as final.","No callback date was set before hanging up."],"objections":[{"said":"I''d want to talk to my husband first.","meant":"Wants shared-decision cover, not permission.","felt":"Anxiety about seeming impulsive with money.","should":"What do you think his first question will be, so we can have the answer ready?","follow":"If it were just your call, where would you land right now?","loop":"Set a specific callback time before ending."}],"profile":["Decision speed: slow, consensus-driven.","Spouse influence: high — treat as a two-person sale.","Trust triggers: preparation she can relay to her husband."],"buyingSignals":["Asked pricing twice unprompted — real interest.","Stall language: ''let me think about it'' — soft no in progress."],"lessons":["Spouse objections are almost never final — isolate and prep her to sell it internally.","Always leave with a set callback time."]}',
'0:03 — Gabriel: Priya, thanks for making time...'),

(4, 1, 'Marcus T.', datetime('now', '-1 day', '-2 hours'), 33, 'manual', NULL, NULL, NULL, NULL, NULL, NULL,
'0:04 — Gabriel: Marcus, good to see you. What made you take the call?
0:31 — Marcus: We are shooting everything on a phone right now and it looks like it. I know it is costing us deals...');

UPDATE calls SET callback_note = 'Callback not yet scheduled — set one',
  precall_brief = 'Last call: wants husband on board before deciding (shared-decision cover, not permission). She asked pricing twice — real interest. Open by asking what his first question was; have the guarantee and payment options ready. Goal this call: a decision date, not a pitch.'
WHERE id = 3;

-- Outputs for the three processed calls (sms + email in all 3 tones, plus GHL note).
INSERT INTO outputs (call_id, kind, tone, subject, body, model, sent_at) VALUES
(1,'sms','casual',NULL,'Hey Jeffrey! Really enjoyed our call tonight. Your VIP agreement''s all set — onboarding will reach out soon to get your team set up and gear on the way. Ping me if you need anything!','mock',NULL),
(1,'sms','balanced',NULL,'Jeffrey, great connecting tonight. Your VIP agreement is complete — the onboarding team will reach out to schedule staff setup and gear shipment. Reach out anytime.','mock',NULL),
(1,'sms','formal',NULL,'Hi Jeffrey. Congratulations — your VIP agreement is complete. Onboarding will follow up shortly regarding staff setup and equipment. Please don''t hesitate to reach out with questions.','mock',NULL),
(1,'email','casual','You''re in, Jeffrey! Here''s what''s next','Hey Jeffrey!\n\nThanks for jumping on the call tonight — your VIP agreement is officially done. Here''s what''s coming:\n\n• Onboarding will reach out about staff setup\n• Your gear is getting ordered and shipped out\n• Any questions at all, just reach out\n\nExcited to see your team rolling with this.\n\n— Gabriel','mock',NULL),
(1,'email','balanced','Your VIP agreement is complete','Jeffrey,\n\nGood connecting tonight. Your VIP agreement is complete — here''s what happens next:\n\n1. Onboarding will reach out to schedule your staff setup\n2. Your gear order will be placed and shipped\n3. Any questions along the way, our team is one message away\n\nLooking forward to getting your team up and running.\n\n— Gabriel','mock',NULL),
(1,'email','formal','Confirmation: Your VIP Agreement','Dear Jeffrey,\n\nThank you for your time this evening. This confirms your VIP agreement is complete. Next steps:\n\n1. Our onboarding team will contact you to schedule staff setup\n2. Your equipment order will be processed and shipped\n3. Please contact our team with any questions\n\nBest regards,\nGabriel','mock',NULL),
(1,'ghl_note',NULL,NULL,'CLOSED — VIP tier. Deal: VIP agreement signed on call. Objections: team adoption (fear of championing a flop) — resolved via onboarding walkthrough. Buying style: fast decider once process clarity established; high D/C. Follow-up: onboarding to schedule staff setup + gear order. Retention risk: low. Upsell: staff seats once team onboarded. Rapport: status/team perception matter more than price; keep comms precise and process-first.','mock',NULL),


(3,'sms','casual',NULL,'Priya! Great talking today. When you chat with your husband, the big ones he''ll probably ask are timeline and the guarantee — happy to jump on a quick call with you both. When works for a follow-up?','mock',datetime('now','-20 hours')),
(3,'sms','balanced',NULL,'Hi Priya, really enjoyed our conversation today. I put together answers to the questions your husband is most likely to have — want me to send them over? Let''s lock in a time to reconnect this week.','mock',NULL),
(3,'sms','formal',NULL,'Hello Priya, thank you for your time today. I''m happy to provide a summary of the program details and guarantee to support your conversation. Could we schedule a brief follow-up call this week?','mock',NULL),
(3,'email','casual','For your conversation with your husband','Priya,\n\nGreat talking today. Here''s the short version to share:\n\n• What it is and the timeline we discussed\n• The investment and payment options\n• The guarantee\n\nIf he has questions, I''m glad to hop on a quick call with you both.\n\nWhat day this week works to reconnect?\n\n— Gabriel','mock',NULL),
(3,'email','balanced','The details you''ll want on hand, Priya','Hi Priya,\n\nThanks again for today. A quick summary to make the conversation with your husband easier:\n\n• The program and timeline we walked through\n• Investment and payment options\n• Our guarantee\n\nCan we set a time to reconnect this week?\n\n— Gabriel','mock',NULL),
(3,'email','formal','Program Summary for Your Review','Dear Priya,\n\nThank you for your time today. To assist your discussion, please find a brief summary below:\n\n• Program scope and timeline as discussed\n• Investment and available payment options\n• Guarantee terms\n\nMight we schedule a brief follow-up call this week?\n\nBest regards,\nGabriel','mock',NULL),
(3,'ghl_note',NULL,NULL,'FOLLOW-UP NEEDED — no close. Objection: ''talk to my husband first'' (shared-decision cover). Real interest: asked pricing twice unprompted. Risk: ''let me think about it'' trending toward soft no. Next step: set a specific callback time; prep her with answers for the husband''s likely questions. Treat as a two-person sale.','mock',NULL);
