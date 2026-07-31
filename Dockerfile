FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY scripts/collab-server.mjs ./scripts/collab-server.mjs

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "scripts/collab-server.mjs"]
