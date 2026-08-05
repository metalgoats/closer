-- TASK-101. Carries a short, bounded, human-readable tail of the debrief as it streams, so the
-- browser's existing poll can show Gabriel the analysis being written instead of a progress bar.
-- Bounded on the WRITE side (see workflow.js) rather than trusted to stay small: this column is
-- rewritten every ~1.5s for the ~3 minutes a generation runs, and an unbounded growing string
-- would turn one generation into a hundred ever-larger D1 writes.
ALTER TABLE calls ADD COLUMN processing_preview TEXT;
