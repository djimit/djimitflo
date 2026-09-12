# Knowledge SSE route G355

The knowledge route fixture starts a real local HTTP server and opens
`GET /knowledge/subscribe/capability-a`:

- response is HTTP 200 with `text/event-stream`;
- the first frame is the route-owned `connected` event for the requested
  capability;
- the reader is cancelled and the server closes cleanly, exercising the
  disconnect cleanup path.

No external provider or production transport is involved.
