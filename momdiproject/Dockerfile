FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/server/public ./dist/src/server/public
COPY --from=build /app/config.json ./config.json
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
