FROM node:24-alpine AS build
WORKDIR /build
RUN npm install --global pnpm@11.25.0 --ignore-scripts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY *.mjs ./
COPY src ./src
COPY public/index.html ./public/index.html
COPY public/samples ./public/samples
COPY scripts/build.mjs scripts/licenses.mjs ./scripts/
RUN node scripts/build.mjs

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV COBUILD_DATA_DIR=/app/.local
WORKDIR /app
COPY --chown=node:node *.mjs ./
COPY --from=build --chown=node:node /build/public ./public
COPY --chown=node:node scripts/start.mjs scripts/runtime-config.mjs scripts/doctor.mjs scripts/backup.mjs ./scripts/
RUN mkdir -p /app/.local && chown node:node /app/.local
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.COBUILD_PORT||process.env.PORT||4173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start.mjs", "--host", "0.0.0.0"]
