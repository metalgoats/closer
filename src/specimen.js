// The worked example (TASK-096).
//
// WHY THIS EXISTS. The debrief prompt used to DESCRIBE the target — "an opinionated executive
// read", "every criticism ships its rewrite". Describing a register transfers it far less
// reliably than showing one. This is the single output Gabriel has confirmed is what he wants:
// the Brandon report from his `GAB sales` folder, kept verbatim.
//
// It became the highest-leverage lever available when TASK-094 came back with one thread —
// the months of accumulated ChatGPT context that were supposed to close the gap had been
// deleted. There is no history to import, so the standard has to be carried in the prompt.
//
// > [!danger] DEBRIEF PASS ONLY. This is coaching material ABOUT THE SELLER.
// > Every passage below critiques Gabriel — absolutes he used, what he should have said,
// > "stop selling". If this reaches a client-facing draft it ships criticism of Gabriel to
// > Gabriel's client. It must never be added to `draftContext()` or the message pass, and
// > `tests/llm.test.mjs` fails the build if it ever appears in a draft prompt.
//
// n=1. This is CALIBRATION, not training — it fixes register and shape, and it cannot teach
// the model Gabriel's clients. Do not treat one example as a dataset.

export const SPECIMEN = `Here is one complete example of the standard this analysis is held to.
It is a real report the operator confirmed was what he wanted. Match its register, its
specificity and its shape. Do NOT copy its content — the call below is a different call.

--- EXAMPLE: EXECUTIVE DIAGNOSIS ---
This was not a failed sales call. It was a strong technical sale that reached commercial
agreement and then stalled at legal diligence.

Brandon is not indecisive, price-sensitive, or hiding behind his spouse. He is a sophisticated
operator who was ready to pay, asked for ACH instructions, accepted the $7,500 package, and
created urgency around an August 16 launch. His resistance came from one central issue: the
verbal promises and the written agreement did not appear to match.

The correct move is not more persuasion. It is precise alignment, documented accountability,
and fast execution.

--- EXAMPLE: A CRITICISM THAT SHIPS ITS REWRITE ---
You made technical and operational statements that were too absolute — "It just works every
time," "Perfect audio 24/7," "We integrate with anything," "Four to seven days." These are
dangerous phrases with a buyer whose central fear is vendor overstatement.

Better language (bounded certainty): "When installed within the tested configuration, the
system is designed to produce a consistent result with minimal manual intervention." … "Our
typical completion range is 14-21 days once required equipment and client inputs are available."

--- EXAMPLE: AN OBJECTION AUTOPSY ---
Objection: The contract does not reflect August 16.
What he said: "The contract says plus 25 days."
What he meant: "You used the August 16 timeline to create urgency, but the company is not
accepting written accountability for it."
Root emotional objection: Prior vendor betrayal.
What you should have said: "You're right. We discussed August 16 as the target, and the
standard agreement gives us more time. I shouldn't ask you to rely on a verbal timeline that is
materially different from the written one. Let me confirm whether it can be written as a
committed date, a best-efforts target with dependencies, or whether we need to tell you
honestly we cannot promise it."
Best follow-up question: "Would you still move forward if August 16 were a documented target
rather than a guarantee, provided the dependencies and contingency plan were clear?"

--- EXAMPLE: A RECIPIENT-SHAPED FOLLOW-UP EMAIL ---
Structured and itemised with zero hype, because this buyer is high-D/high-C. A relational buyer
would get a short warm note instead.

Hi Brandon,
You are clearly aligned with the VIP Standard system and ready to move quickly. The remaining
issue is making sure the written agreement accurately reflects the operating plan we discussed.
The main items we need to review are:
- Whether technician-approved existing equipment remains covered
- Whether August 16 can be documented as a committed date or target
- How seated and standing configurations will be handled
- What support applies if a software update disrupts the tested setup
- Which communication channel should be used for support
- How the two-payment structure and project milestones will be documented
Please send your full comments when ready. I will review them with Jason and Wyatt and return a
direct response to each item. Once those terms are resolved, we can finalize the agreement,
process the ACH payment, complete the gear audit, and begin immediately.

--- EXAMPLE: THE FINAL VERDICT ---
You did enough to sell the product. You now need to prove the company can deliver the business
relationship. The greatest mistake would be continuing to "close" Brandon. He is already closed
emotionally and financially.

--- END OF EXAMPLE ---
Now analyse the actual call below to that same standard.`;

// Rough token count for logging. Deliberately an estimate with an honest name rather than a
// number pretending to be exact — the real figure comes back in usage on every call.
export const SPECIMEN_APPROX_TOKENS = Math.round(SPECIMEN.length / 3.7);
