# Workstation URL route proof G366

Authenticated local HTTP executed `GET /api/workstation/urls`. The route invokes the bounded native socket inventory and returns a structured `{host, platform, ports}` response (or explicit 503 when the host inventory command is unavailable), without synchronous `lsof` blocking.
