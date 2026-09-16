FROM node:22-alpine

WORKDIR /app

# Copy root package definitions
COPY package.json package-lock.json* ./
COPY packages/mcp/package.json ./packages/mcp/

# Install runtime dependencies including tsx
RUN npm install --omit=dev && npm install -g tsx

# Copy full application source
COPY . .

ENV AGENT_MARKET_URL=https://aiagentmarket.pages.dev

# Run MCP server over stdio for Glama inspection
CMD ["tsx", "packages/mcp/src/index.ts"]
