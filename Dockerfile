FROM node:22-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base AS dev
COPY vite.config.js index.html ./
COPY src/ ./src/
EXPOSE 5173
CMD ["npm", "run", "dev"]

FROM base AS build
COPY vite.config.js index.html ./
COPY src/ ./src/
RUN npm run build

FROM nginx:alpine AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
