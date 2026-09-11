# G248 Knowledge publish validation

The authenticated `/api/knowledge/publish` boundary now validates identifier
types, optional string fields, confidence/trust scores in `[0,1]`, and
string-only evidence references before publishing to the KnowledgeBus. Nullish
defaults preserve explicit zero scores.

Validation:

- focused route tests: **2 passed / 0 failed** (four malformed payload classes,
  no event publication, and a valid zero-score claim)
- server type-check: pass
- server lint: pass
- full server regression: **2,509 passed / 20 skipped / 0 failed** (321 files;
  the disposable fixture emits one expected non-Git diagnostic)
- governed `/loops`: **23 files, 291 passed, 1 skipped, 0 failed**
