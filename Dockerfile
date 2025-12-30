# ============================================================
# Aryeo Delivery Runner - Production Dockerfile
# ============================================================

# -----------------------
# Stage 1: Build
# -----------------------
    FROM node:20-bookworm-slim AS builder

    WORKDIR /app
    
    # Copy package files
    COPY package*.json ./
    
    # Install all deps (including dev deps for TS build)
    RUN npm ci
    
    # Copy source
    COPY tsconfig.json ./
    COPY src ./src
    
    # Build TS
    RUN npm run build
    
    
    # -----------------------
    # Stage 2: Production
    # -----------------------
    FROM mcr.microsoft.com/playwright:v1.57.0-jammy
    
    WORKDIR /app
    
    # Install curl (for healthcheck)
    RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        && rm -rf /var/lib/apt/lists/*
    
    # Copy package files again (prod deps only)
    COPY package*.json ./
    
    # Install prod deps only
    RUN npm ci --omit=dev
    
    # Install Playwright browsers (CRITICAL)
    RUN npx playwright install --with-deps chromium
    
    # Copy built app from builder
    COPY --from=builder /app/dist ./dist
    
    # Create runtime directories
    RUN mkdir -p /app/data/auth /app/data/evidence
    
    # Create non-root user
    RUN groupadd --gid 1001 nodejs && \
        useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home appuser && \
        chown -R appuser:nodejs /app
    
    USER appuser
    
    EXPOSE 8080
    
    ENV NODE_ENV=production
    ENV RUNNER_PORT=8080
    ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
    
    HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
      CMD curl -f http://localhost:8080/health || exit 1
    
    CMD ["node", "dist/server.js"]
    