# =============================================================================
# Aryeo Delivery Runner - Production Dockerfile
# =============================================================================
# Multi-stage build for optimized image size
# Includes Playwright Chromium for browser automation
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: Production
# -----------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.48.0-jammy AS production

# Set working directory
WORKDIR /app

# Create non-root user for security
RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home appuser

# Install curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy any additional files needed at runtime
COPY scripts ./scripts

# Create data directories with correct permissions
RUN mkdir -p /app/data/auth /app/data/evidence && \
    chown -R appuser:nodejs /app/data

# Set environment defaults
ENV NODE_ENV=production \
    RUNNER_PORT=8080 \
    PLAYWRIGHT_HEADLESS=true \
    DATA_DIR=/app/data \
    # Skip Playwright browser download - we use the pre-installed browsers
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Expose port
EXPOSE 8080

# Switch to non-root user
USER appuser

# Default command (can be overridden in docker-compose)
CMD ["node", "dist/server.js"]

# -----------------------------------------------------------------------------
# Health check
# -----------------------------------------------------------------------------
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1
