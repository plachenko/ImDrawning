FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
ENV APP_BASE_PATH=""
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY scripts/collab-server.mjs ./scripts/collab-server.mjs
COPY --from=build /app/build ./build

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "scripts/collab-server.mjs"]
