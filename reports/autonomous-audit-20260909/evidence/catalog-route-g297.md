# Agent catalog projection proof — G297

The authenticated catalog lifecycle fixture now verifies both aggregate catalog projections: `/catalog/counts` and `/catalog/evaluate/summary` agree with the imported and manually evaluated profile after durable catalog reopen. Focused catalog HTTP suite passes 10/10.

This proves catalog persistence and projection consistency locally. Runtime registration/dispatch remains explicitly false in the existing catalog contract and is not inferred from these counts.
