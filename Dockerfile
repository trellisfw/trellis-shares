ARG NODE_VER=16-alpine
ARG SERVICE=trellis/shares

FROM node:$NODE_VER AS install
ARG SERVICE

WORKDIR /$SERVICE

COPY ./.yarn /$SERVICE/.yarn
COPY ./package.json ./yarn.lock ./.yarnrc.yml /$SERVICE/

RUN yarn workspaces focus --all --production

FROM install AS build
ARG SERVICE

# Install dev deps too
RUN yarn install --immutable

COPY . /$SERVICE/

# Build code and remove dev deps
RUN yarn build --verbose && rm -rfv .yarn .pnp*

FROM node:$NODE_VER AS production
ARG SERVICE

# Install needed packages
RUN apk add --no-cache \
    dumb-init

# Do not run service as root
USER node

WORKDIR /$SERVICE

COPY --from=install /$SERVICE/ /$SERVICE/
COPY --from=build /$SERVICE/ /$SERVICE/

# Launch entrypoint with dumb-init
# Remap SIGTERM to SIGINT https://github.com/Yelp/dumb-init#signal-rewriting
ENTRYPOINT ["/usr/bin/dumb-init", "--rewrite", "15:2", "--", "yarn", "run"]
CMD ["start"]
