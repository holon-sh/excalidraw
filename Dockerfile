FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY holon.yaml server.json tsconfig.json vite.config.ts ./
COPY src src
COPY ui ui
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
LABEL io.modelcontextprotocol.server.name="io.github.holon-sh/excalidraw" \
      org.opencontainers.image.source="https://github.com/holon-sh/excalidraw" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
COPY --from=build /app/package.json /app/server.json ./
COPY --from=build /app/src src
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
EXPOSE 3000
USER node
CMD ["node", "src/serve.ts"]
