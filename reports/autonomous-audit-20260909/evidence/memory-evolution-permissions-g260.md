# G260 memory-evolution authorization boundary

The `/memory-evolution` mount previously supplied authentication only; its route factory had no role permissions. The factory now requires `write:evidence` for trace ingestion, `write:governance` for evolution scheduling, promotion evaluation and lease creation, and `read:evidence` for retrieval, quality and lease reads. The production mount now passes the existing auth middleware into the factory.

The real JWT role matrix in `route-permissions-http.test.ts` proves admin/maker/checker ingestion (201), admin-only governance scheduling/lease creation (200/201), denial of unsupported roles (403), and no unauthorized candidate/goal/lease persistence. Direct memory-evolution service tests remain unchanged and continue to use the explicit no-op auth fixture.
