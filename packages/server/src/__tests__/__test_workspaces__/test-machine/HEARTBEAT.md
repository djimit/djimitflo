# HEARTBEAT — test-machine
## Dagelijks 05:31
- POST http://192.168.1.28:3001/api/agents/test-machine/heartbeat
- Check pending tasks: GET /api/tasks?status=pending&created_by=test-machine

## Bij idle (>30 min geen activiteit)
- Stuur heartbeat met status=idle
