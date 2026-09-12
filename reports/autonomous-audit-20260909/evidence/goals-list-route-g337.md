# Goals list route G337

The existing loop HTTP fixture now mounts the canonical `/api/goals` router
and executes `GET /api/goals/` after creating a goal. The response is HTTP 200
and contains the newly persisted goal by id and objective. This proves the
list projection is connected to goal creation over local SQLite; production
authentication and live deployment behavior remain outside this fixture.
