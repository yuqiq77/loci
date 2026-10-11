FROM node:22-alpine AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ARG APP_ORIGIN=http://localhost:3000
ARG DATABASE_URL=postgresql://loci:loci@postgres:5432/loci
ENV APP_ORIGIN=$APP_ORIGIN
ENV DATABASE_URL=$DATABASE_URL
RUN npm run build

FROM dependencies AS migrator
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY src/server/env.ts ./src/server/env.ts
COPY tsconfig.json ./

CMD ["npm", "run", "db:migrate"]

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
