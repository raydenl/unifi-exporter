FROM arm64v8/node:18-bookworm AS build

WORKDIR /usr/src/app

COPY tsconfig.json ./
COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# Production
FROM arm64v8/node:18-bookworm-slim AS release

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev

COPY --from=build /usr/src/app/dist ./dist

# Ensure /usr/temp exists and create a blank file
#RUN mkdir -p /usr/temp && touch /usr/temp/myhosts.list

EXPOSE 8080

CMD [ "node", "./dist/index.js" ]