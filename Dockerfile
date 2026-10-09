FROM oven/bun:1.2.22-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/bot/package.json apps/bot/package.json
RUN bun install --frozen-lockfile || bun install

FROM deps AS web-build
COPY apps/web apps/web
RUN bun run --cwd apps/web build

FROM deps AS api
WORKDIR /app
COPY apps/api apps/api
COPY --from=web-build /app/apps/web/dist apps/api/public
RUN bun run --cwd apps/api prisma:generate
EXPOSE 3011
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then bun run --cwd apps/api prisma:deploy; fi && bun run --cwd apps/api start"]

FROM deps AS bot
WORKDIR /app
COPY apps/bot apps/bot
CMD ["bun", "run", "--cwd", "apps/bot", "start"]
