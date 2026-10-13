# ------------------------------------------------------------------ build stage
FROM node:20-slim AS build

WORKDIR /app

# Install all deps (including dev) so Vite can build the client.
COPY package.json package-lock.json ./
RUN npm ci

COPY client/ ./client/
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY .env.example ./.env.example

# Build the client bundle.
RUN npm run build

# ------------------------------------------------------------------ production stage
FROM node:20-slim AS production

WORKDIR /app

# Install only production deps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the built client + server source.
COPY --from=build /app/client/dist ./client/dist
COPY server/ ./server/
COPY scripts/ ./scripts/

# Non-root user for security.
RUN addgroup --system --gid 1001 syncaudio && \
    adduser --system --uid 1001 --ingroup syncaudio syncaudio && \
    mkdir -p /app/.syncaudio-uploads && \
    chown -R syncaudio:syncaudio /app

USER syncaudio

EXPOSE 4000

ENV NODE_ENV=production
ENV PORT=4000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
