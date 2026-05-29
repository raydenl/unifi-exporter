FROM arm64v8/node:22-bookworm AS build

WORKDIR /usr/src/app

COPY tsconfig.json ./
COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# Production
FROM arm64v8/node:22-alpine AS release

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev

COPY --from=build /usr/src/app/dist ./dist

RUN chown -R node:node /usr/src/app

USER node

EXPOSE 8080

CMD [ "node", "./dist/index.js" ]