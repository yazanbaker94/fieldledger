FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY deploy/compose-entrypoint.sh /usr/local/bin/fieldledger-entrypoint
RUN command -v flock && install -d -o node -g node /app/asset-cache \
    && install -o node -g node -m 0644 /dev/null /app/asset-cache/.lock
USER node
EXPOSE 3000
ENTRYPOINT ["sh", "/usr/local/bin/fieldledger-entrypoint"]
CMD ["node", "--import", "tsx", "server/index.ts"]
