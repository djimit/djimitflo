# GitHub webhook route proof G369

The out-of-band `/github/webhook` route is directly exercised with exact HMAC-SHA256 bytes and an existing disposable repository path. The test proves untrusted issue content is imported into a durable work item, duplicate delivery is idempotent, a new delivery preserves operator scheduling state, and no goal/loop/execution starts automatically. Missing configuration and invalid signatures remain fail-closed.
