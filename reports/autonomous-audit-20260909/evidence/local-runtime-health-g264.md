# G264 local runtime health probe

The built server started on `127.0.0.1:3001` and was stopped cleanly after a read-only route probe:

- `GET /health` → 200, `status=healthy`
- `GET /api/version` → 200, `version=0.5.8`
- `GET /api/health` → 200, `status=healthy`
- `GET /api/openapi.json` → 401 `AUTH_REQUIRED`
- `GET /api/health/deep` → 401 `AUTH_REQUIRED`

The local process reported `commit=null` because this dirty audit checkout is not a release identity. No authenticated domain operation or production identity is inferred.

