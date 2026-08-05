FROM node:22-bookworm-slim AS build

WORKDIR /app

ARG VITE_API_BASE_URL=/api
ARG VITE_WS_BASE_URL=/ws/uploads
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_WS_BASE_URL=$VITE_WS_BASE_URL

COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
COPY shared ./shared
RUN npm ci --workspace=frontend --include-workspace-root

COPY frontend/ ./frontend/
RUN npm run build --workspace=frontend

FROM nginx:1.27-alpine AS runtime

COPY frontend/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
