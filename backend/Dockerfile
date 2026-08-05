FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci --omit=dev --workspace=backend --include-workspace-root

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ffmpeg \
		fonts-dejavu-core \
		libreoffice-calc \
		libreoffice-core \
		libreoffice-impress \
		libreoffice-writer \
		poppler-utils \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY backend/package*.json ./
COPY backend/src ./src
COPY shared ./shared

RUN mkdir -p /app/data /app/cache/files

EXPOSE 8787
CMD ["npm", "start"]
