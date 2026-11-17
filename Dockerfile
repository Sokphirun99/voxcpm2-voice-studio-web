FROM node:22-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base AS dev
COPY vite.config.js index.html ./
COPY public/ ./public/
COPY src/ ./src/
EXPOSE 5173
CMD ["npm", "run", "dev"]

FROM node:22-bookworm-slim AS storage
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src/domain/ ./src/domain/
COPY server/ ./server/
ENV PORT=8090 DATA_DIR=/data
EXPOSE 8090
CMD ["node", "server/index.js"]

FROM base AS build
COPY vite.config.js index.html ./
COPY public/ ./public/
COPY src/ ./src/
RUN npm run build

FROM nginx:alpine AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
