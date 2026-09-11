# Explainer ask route proof G362

The canonical grounded Q&A route is exercised over local HTTP/SQLite. A malformed question is rejected with `400 VALIDATION_ERROR`; a valid question returns an answer/refusal payload and persists one `ask_query` audit record with outcome lineage. No external provider quality or production identity claim is inferred.
