# ── Rentlyst Backend – Dockerfile ──────────────────────────────────────────────
# Stage 1: Builder — install all deps (including devDeps for any build steps)
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests first to leverage Docker layer caching
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy the rest of the source
COPY . .

# ── Stage 2: Runner — lean production image ─────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Create a non-root user for security
RUN addgroup -S rentlyst && adduser -S rentlyst -G rentlyst

# Copy installed modules and source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

# Drop privileges
USER rentlyst

# Expose the port the app listens on (matches app.js: process.env.PORT || 10000)
EXPOSE 10000

# Health-check so Docker/Compose can track readiness
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:10000/ || exit 1

ENV NODE_ENV=production

CMD ["node", "app.js"]
