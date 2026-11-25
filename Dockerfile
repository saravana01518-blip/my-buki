# Dockerfile for deploying buki-connector-kit to Railway, Render, Fly.io, or any container host
FROM node:22-alpine

WORKDIR /app

# Install dependencies first for efficient layer caching
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy application source and fixtures
COPY tsconfig.json vitest.config.mts ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY mock/ ./mock/
COPY fixtures/ ./fixtures/

# Pre-run build to verify TypeScript compilation
RUN npm run build

# Default environment variables for fixture mode
ENV NODE_ENV=production
ENV PORT=3000
ENV FINANCE_SOURCE=sage
ENV SAGE_USE_FIXTURES=true
ENV HR_SOURCE=bamboohr

EXPOSE 3000

CMD ["npm", "run", "start:web"]
