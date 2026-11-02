# Methodology and HCI interpretation

Inspection combined navigation discovery, task walkthroughs, saved visual states, deployed-source tracing and read-only runtime/database reconciliation. This is expert systems/HCI evaluation, not a controlled user experiment. No statistical confidence interval or usability score is fabricated from one operator session.

The expert rubric follows system-status visibility, meaningful language, consistent interaction, recognition rather than memory, efficient task completion and diagnostic recovery in [Nielsen's usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/). For DjimitFlo, a healthy badge with a wrong population is a visibility/mental-model failure; carrying IDs between domains is recall burden; false terminal events impede recovery; an explicit unmeasured label supports correct decisions. These are audit interpretations tied to observed evidence, not claims that a heuristic alone proves a defect.

Accessibility inspection considered reflow, keyboard operation/focus, headings/labels, programmatic control names and status announcements from [WCAG2.2](https://www.w3.org/TR/WCAG22/). Visible desktop overlap and source landmarks were recorded, but 320 CSS-pixel reflow, zoom, screen-reader output, contrast and complete keyboard journeys were not tested. No WCAG conformance verdict follows from screenshots. Existing pause/live and status patterns should be preserved and tested with actual assistive technology.

For measurements, six validity questions governed interpretation:

1. **Construct:** does the number measure activity, a decision, a completed execution, verification, survival or causal improvement?
2. **Unit:** event, panel, proposal, distinct candidate, goal, task, lease and model call are not interchangeable.
3. **Population/time:** current state vs transition event, creation vs update time, explicit cohort/exclusions, rolling window and independent refresh clocks.
4. **Provenance:** authoritative writer/table/query and explicit joins; runtime artifact identity before correlating source.
5. **Missingness:** unpriced/unattributed/unreviewed/unknown is not zero; source failures must not silently become healthy empties.
6. **Causality:** temporal order, transport success, a green score and a completed run do not establish sustained benefit. Independent outcome evidence and credible comparison are required.

Priorities combine operational decision consequence, data integrity, frequency/evidence, user effort, severity and implementation/regression risk. No arithmetic score masks uncertainty about frequency or human time savings. H lists measurable acceptance hypotheses; F records actual paths and unavailable timing. Literature checked 23Oct 2026; product conclusions derive primarily from runtime/source evidence.
