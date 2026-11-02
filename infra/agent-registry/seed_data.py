from models import Agent

SEED_AGENTS: list[Agent] = [
    Agent(
        name="hermes-workstation",
        bot_name="Djimit2_bot",
        host="192.168.1.28",
        runtime="docker",
        version="v30",
        framework="hermes",
        capabilities=[
            "telegram", "memory", "browser", "code_exec", "mcp",
            "kanban", "cron", "delegation", "lsp", "tts", "stt",
            "voice", "checkpoints", "curator", "x_search"
        ],
        mcp_servers=["codegraph", "knowledge-mcp", "qdrant-knowledge"],
        auxiliary_models=[
            "gpt-4o", "gpt-4o-mini", "claude-sonnet-4-20250514",
            "claude-haiku-4-5", "gemini-2.5-flash", "gemini-2.5-pro",
            "deepseek-chat", "deepseek-reasoner", "ollama-llama3.3",
            "ollama-qwen2.5", "ollama-codellama", "ollama-mistral"
        ],
        approval="auto",
    ),
    Agent(
        name="hermes-macmini",
        bot_name="DjimitMacMini_bot",
        host="192.168.1.61",
        runtime="launchagent",
        version="v23",
        framework="hermes",
        capabilities=[
            "telegram", "memory", "browser", "code_exec", "mcp",
            "kanban", "cron", "delegation", "tts", "stt", "voice",
            "checkpoints", "curator", "x_search"
        ],
        mcp_servers=["knowledge-mcp", "qdrant-knowledge"],
        approval="auto",
    ),
    Agent(
        name="hermes-eve-v",
        bot_name="Djimit3_bot",
        host="192.168.1.208",
        runtime="systemd",
        version="v23",
        framework="hermes",
        capabilities=[
            "telegram", "memory", "browser", "code_exec", "mcp",
            "kanban", "cron", "delegation", "lsp", "tts", "stt",
            "voice", "curator", "x_search", "searxng"
        ],
        mcp_servers=["knowledge-mcp", "qdrant-knowledge", "djimit2"],
        personalities=[
            "analytical", "creative", "skeptical", "mentor",
            "devil_advocate", "synthesist", "pragmatist",
            "visionary", "catalyst", "guardian", "navigator",
            "archivist", "diplomat", "investigator"
        ],
        quick_commands=["brief", "draft", "lead", "news", "tender"],
        approval="manual",
        language="nl",
    ),
    Agent(
        name="openclaw-workstation",
        bot_name="Djimit_bot",
        host="192.168.1.28",
        runtime="cli",
        version="v2026.6.11",
        framework="openclaw",
        capabilities=[
            "telegram", "subagents", "plugins", "web_search",
            "sandbox", "agent_to_agent"
        ],
        sub_agents=["main", "research", "coding", "content", "monitoring"],
        plugins=[
            "anthropic", "webhooks", "memory-wiki", "active-memory",
            "tavily", "brave", "workboard", "policy"
        ],
        mcp_servers=["mcp1", "mcp2", "mcp3", "mcp4"],
    ),
    Agent(
        name="openclaw-macbook",
        bot_name="Djimit_bot",
        host="local",
        runtime="cli",
        version="v2026.6.8",
        framework="openclaw",
        capabilities=["telegram", "plugins"],
        plugins=["openai"],
        mcp_servers=["mcp1"],
    ),
    Agent(
        name="scallop",
        bot_name="Djimit_bot",
        host="192.168.1.28",
        runtime="node-host",
        version="v0.1.0",
        framework="scallop",
        capabilities=[
            "telegram", "discord", "whatsapp", "slack", "signal",
            "matrix", "cli", "rest_api", "websocket", "memory",
            "dream_cycle", "evolution", "proactive_intelligence",
            "spreading_activation", "affect_awareness", "self_reflection",
            "subagent_orchestration", "board_kanban", "goals", "voice",
            "tts", "stt", "eval", "tailscale"
        ],
        skills=[f"skill_{i}" for i in range(28)],
        llm_providers=["openai", "anthropic", "ollama", "groq", "gemini", "mistral", "deepseek"],
        api_endpoint="http://192.168.1.28:9121",
    ),
    Agent(
        name="deerflow",
        bot_name="Djimitflowbot",
        host="192.168.1.28",
        runtime="docker",
        version="latest",
        framework="deerflow",
        capabilities=[
            "deep_research", "consulting", "subagent_dispatch",
            "skill_evolution", "loop_detection", "memory_facts",
            "skill_install", "thread_management", "file_upload",
            "chart_generation", "podcast_generation", "ppt_generation",
            "video_generation", "image_generation", "literature_review",
            "academic_review", "data_analysis", "frontend_design",
            "web_design_audit", "newsletter_generation", "github_research",
            "incident_triage", "workstation_ops"
        ],
        sub_agents=["agent1", "agent2", "agent3", "agent4", "agent5"],
        skills=[f"skill_{i}" for i in range(20)],
        api_endpoint="http://192.168.1.28:2026",
    ),
    Agent(
        name="overwatch",
        bot_name="",
        host="192.168.1.28",
        runtime="systemd",
        version="latest",
        framework="overwatch",
        capabilities=[
            "health_monitoring", "syntax_checking", "resource_tracking",
            "agent_polling", "alerting"
        ],
    ),
]
