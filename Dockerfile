# Base manifest digests resolved during the verified local ARM64 BuildKit build.
FROM node:26.0.0-alpine@sha256:30f5a66e7265ef70aac56b4753ffa7905e54eca1084bc25503893ad8e9273f05 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_DRAFTROOM_STORAGE=server
ENV VITE_DRAFTROOM_STORAGE=$VITE_DRAFTROOM_STORAGE
RUN npm run build

FROM nginx:stable-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/nginx/html/
EXPOSE 80
