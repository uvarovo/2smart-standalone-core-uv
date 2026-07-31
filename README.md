# 2smart-core

MQTT backend service for the 2Smart Standalone platform.

## Requirements

- Node.js 16 (the project is pinned to `node:12.12-alpine` in the production
  Dockerfile, but local development works on Node 16 thanks to the
  `lockfileVersion: 2` lockfile — newer Node versions are not tested).
- npm 8+.
- A reachable MQTT broker and MySQL database (see `etc/config.js` and
  `etc/db.js` for the expected environment variables).

## Local development

```bash
# Install dependencies. `--legacy-peer-deps` is required because of older
# ESLint peer ranges pulled in by `eslint-plugin-jest`.
npm ci --legacy-peer-deps

# Lint the sources.
npm run test:lint

# Run the service with nodemon (auto-reloads on changes).
npm run nodemon

# Or run once via Babel register.
npm start
```

The entry point is `runner.js`, which loads `@babel/register` and then
`app.js`, which constructs and initialises the `Core` class from
`lib/Core.js`.

## Continuous integration

Two CI pipelines are kept in sync:

- **GitHub Actions** — `.github/workflows/lint.yml` runs `npm run test:lint`
  on every push and pull request against `master`/`main`.
- **GitLab CI** — `.gitlab-ci.yml` runs the same lint step on merge requests
  and `master`, and additionally builds and pushes multi-arch Docker images.

## Multi-stage Docker builds (amd64 and arm32v7)

1. Build images for AMD and ARM (the ARM image must be built on the target
   platform):

    ```bash
    docker build --file Dockerfile       -t <IMAGE>:latest-amd64   --build-arg ARCH=amd64/   .
    docker build --file Dockerfile.arm32 -t <IMAGE>:latest-arm32v7 --build-arg ARCH=arm32v7/ .
    ```

2. Push to registry:

    ```bash
    docker push <IMAGE>:latest-amd64
    docker push <IMAGE>:latest-arm32v7
    ```

3. Compile the Docker manifest:

    ```bash
    docker manifest create <IMAGE>:latest \
        --amend <IMAGE>:latest-amd64 \
        --amend <IMAGE>:latest-arm32v7
    ```

4. Push the manifest to registry:

    ```bash
    docker manifest push <IMAGE>:latest
    ```

## License

See [LICENSE.txt](./LICENSE.txt) (English) and
[LICENSE_UA.txt](./LICENSE_UA.txt) (Ukrainian).
