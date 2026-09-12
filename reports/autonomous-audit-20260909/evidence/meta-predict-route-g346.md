# Meta prediction route G346

The meta orchestration fixture mounts `/api/meta` and executes an authenticated
viewer `POST /api/meta/predict` with a valid task shape. The route returns HTTP
200 with the deterministic `willFail=false` and `confidence=0.5` prediction;
malformed inputs remain rejected with HTTP 400 in the same fixture.
