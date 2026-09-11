FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Chromium is used by the authenticated LinkedIn-direct collector so Voyager
# requests originate from a real, cookie-authenticated browser context.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/server/public ./dist/src/server/public
COPY --from=build /app/config.json ./config.json
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
