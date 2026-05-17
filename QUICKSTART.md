# Djimitflo - Quick Start Guide

Get up and running with Djimitflo in 60 seconds.

## Prerequisites

- Node.js 18+
- npm 9+

## Installation

```bash
cd /Users/dlandman/djimitflo
npm install
```

## First-Time Setup

### 1. Build All Packages

```bash
npm run build
```

### 2. Seed the Database

```bash
npm run db:seed --workspace=@djimitflo/server
```

This creates:
- ✅ 4 AI agents (CodeReviewer, TestRunner, DeploymentBot, DocGenerator)
- ✅ 6 sample tasks across different states
- ✅ SQLite database at `.data/djimitflo.sqlite`

## Running the Application

### Option 1: Start Everything (Recommended)

```bash
npm run dev
```

This starts both:
- 🔧 Backend server on `http://localhost:3001`
- 🎨 Frontend dashboard on `http://localhost:5173`

### Option 2: Start Individually

```bash
# Terminal 1: Backend
npm run dev:server

# Terminal 2: Frontend
npm run dev:dashboard
```

## Access the Dashboard

Open your browser:
```
http://localhost:5173
```

## What You'll See

### Dashboard Page
- **System Overview**: Active tasks, completed, failed, queued
- **Health Metrics**: Uptime, memory usage, active agents
- **Recent Activity**: Live task updates
- **Connection Status**: Green dot = WebSocket connected

### Tasks Page
- **6 Seeded Tasks**: Code review, testing, deployment, etc.
- **Search & Filter**: Find tasks by name or status
- **Create New Task**: Click "+ New Task" button
- **Real-time Updates**: Tasks update instantly via WebSocket

### Agents Page
- **4 Configured Agents**: Each with capabilities and metrics
- **Success Rates**: Visual progress bars
- **Current Tasks**: See what each agent is working on
- **Status Indicators**: Active, idle, error, offline

## Testing the Flow

### Create a New Task

1. Go to **Tasks** page
2. Click **"+ New Task"**
3. Fill in:
   - Title: "Test my new feature"
   - Description: "Verify the login flow works"
   - Priority: High
   - Execution Mode: Review Only
   - Agent: CodeReviewer
4. Click **"Create Task"**
5. ✨ Task appears immediately in the list!

### Check Real-time Updates

1. Open browser DevTools → Network tab → WS
2. See WebSocket connection to `ws://localhost:3001/ws`
3. Create a task
4. See WebSocket message: `{"type":"task.created",...}`
5. Task appears in UI without refresh!

## API Endpoints

Try these in your browser or with `curl`:

```bash
# Health check
curl http://localhost:3001/health

# List all tasks
curl http://localhost:3001/api/tasks

# List all agents
curl http://localhost:3001/api/agents

# Get API version
curl http://localhost:3001/api/version

# Create a task
curl -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "API Test Task",
    "description": "Testing the API",
    "priority": "medium"
  }'
```

## Database

### Location
```
/Users/dlandman/djimitflo/.data/djimitflo.sqlite
```

### Inspect with SQLite

```bash
sqlite3 .data/djimitflo.sqlite

sqlite> .tables
sqlite> SELECT * FROM tasks;
sqlite> SELECT * FROM agents;
sqlite> .quit
```

### Re-seed Database

```bash
# Clear and re-seed
rm .data/djimitflo.sqlite*
npm run db:seed --workspace=@djimitflo/server
```

## Development

### Project Structure

```
djimitflo/
├── packages/
│   ├── shared/           # TypeScript types
│   ├── server/           # Express backend
│   └── dashboard/        # React frontend
└── .data/                # SQLite database
```

### Key Files

- **Backend entry**: `packages/server/src/index.ts`
- **Frontend entry**: `packages/dashboard/src/main.tsx`
- **Database schema**: `packages/server/src/database/schema.ts`
- **API routes**: `packages/server/src/routes/`
- **React pages**: `packages/dashboard/src/pages/`
- **State store**: `packages/dashboard/src/lib/store.ts`
- **API client**: `packages/dashboard/src/lib/api.ts`

### Build for Production

```bash
# Build all packages
npm run build

# Start production server
npm run start --workspace=@djimitflo/server
```

## Troubleshooting

### Port Already in Use

```bash
# Kill process on port 3001
lsof -ti:3001 | xargs kill -9

# Kill process on port 5173
lsof -ti:5173 | xargs kill -9
```

### Database Locked

```bash
# Close any SQLite connections
pkill -9 sqlite3

# Remove lock files
rm .data/*.sqlite-shm .data/*.sqlite-wal
```

### WebSocket Not Connecting

1. Check backend is running: `curl http://localhost:3001/health`
2. Check browser console for errors
3. Verify `.env.local` settings:
   ```
   VITE_API_BASE=http://localhost:3001/api
   VITE_WS_URL=ws://localhost:3001/ws
   ```

### TypeScript Errors

```bash
# Re-build shared package
npm run build --workspace=@djimitflo/shared

# Check for errors
npm run type-check --workspace=@djimitflo/server
npm run type-check --workspace=@djimitflo/dashboard
```

## Next Steps

- 📖 Read the full [README.md](README.md)
- 🎯 Check [PHASE2_SUMMARY.md](PHASE2_SUMMARY.md) for features
- 🚀 Explore Phase 3 features (coming soon)

## Support

Questions or issues? Contact: Dennis Landman (DjimIT Consulting)

---

**Happy Orchestrating! 🚀**
