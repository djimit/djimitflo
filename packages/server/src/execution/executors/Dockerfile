FROM node:20-alpine

RUN apk add --no-cache git bash curl docker-cli

# Install global CLI tools
RUN npm install -g @anthropic-ai/claude-code openai codex

WORKDIR /workspace

ENTRYPOINT ["/bin/bash"]
