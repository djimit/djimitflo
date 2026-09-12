# G245 Gym anonymous-auth recheck

The built production-profile server was started as a subprocess against a
fresh disposable SQLite database on `127.0.0.1:3191`. Anonymous HTTP probes
against all four mounted Gym contract families were repeated without an
`Authorization` header:

- `GET /api/gym/governance/:skillId`: 10/10 returned 401
- `GET /api/gym/governance/:skillId/history`: 10/10 returned 401
- `GET /api/gym/governance/:skillId/curriculum`: 10/10 returned 401
- `POST /api/gym/governance/:skillId/run`: 30/30 returned 401

The response body was `{"error":{"message":"Authentication required","code":"AUTH_REQUIRED"}}`.
The server was stopped after the probe. This fresh real-server result does not
erase the earlier non-reproducible anonymous-200 observation; it reduces its
current reproducibility while the historical result remains retained as
UNKNOWN evidence.
