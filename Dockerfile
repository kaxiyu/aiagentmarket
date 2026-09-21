FROM node:22-alpine

WORKDIR /app

# Copy package definitions and compiled MCP server
COPY package.json ./
COPY packages/mcp ./packages/mcp

ENV AGENT_MARKET_URL=https://aiagentmarket.pages.dev

# Run MCP server over stdio for Glama introspection and inspector checks
CMD ["node", "packages/mcp/dist/index.js"]
