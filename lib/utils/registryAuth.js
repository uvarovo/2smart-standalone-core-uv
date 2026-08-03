/* eslint-disable no-sync */
const fs = require('fs-extra');
const imageParser = require('parse-docker-image-name');

// dockerode never looks at the Docker CLI's credential store, so a `docker
// login` on the host does nothing for pulls issued through the API. Private
// registries (e.g. the self-hosted drop.uvarovo.net:32102) therefore answer
// every pull with 401 unless we hand dockerode an authconfig ourselves.
//
// Credentials are read from a mounted Docker config file (the conventional
// place, so `docker login` on the host stays the single source of truth) and
// may be overridden per-run with REGISTRY_AUTH_* env variables.
const DOCKER_CONFIG_PATH = process.env.DOCKER_CONFIG_PATH || '/root/.docker/config.json';
const DOCKER_HUB_KEYS = [ 'https://index.docker.io/v1/', 'index.docker.io', 'docker.io' ];

function normalizeHost(host) {
    return String(host || '')
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');
}

// An image reference without a registry host (`uvarovo/image:tag`) implicitly
// means Docker Hub, whose credentials are stored under a legacy key.
function registryHostOf(image) {
    const { domain } = imageParser(image);

    return domain ? normalizeHost(domain) : 'docker.io';
}

function authFromEnv(host) {
    const { REGISTRY_AUTH_SERVER, REGISTRY_AUTH_USERNAME, REGISTRY_AUTH_PASSWORD } = process.env;

    if (!REGISTRY_AUTH_USERNAME || !REGISTRY_AUTH_PASSWORD) return null;

    const server = normalizeHost(REGISTRY_AUTH_SERVER) || 'docker.io';

    if (server !== host) return null;

    return {
        username      : REGISTRY_AUTH_USERNAME,
        password      : REGISTRY_AUTH_PASSWORD,
        serveraddress : server
    };
}

function authFromConfig(host) {
    let config = null;

    try {
        config = fs.readJSONSync(DOCKER_CONFIG_PATH);
    } catch (e) {
        return null;
    }

    const auths = (config && config.auths) || {};
    const keys = host === 'docker.io' ? DOCKER_HUB_KEYS : [ host ];
    const key = keys.find((candidate) => auths[candidate] && auths[candidate].auth);

    if (!key) return null;

    const decoded = Buffer.from(auths[key].auth, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');

    if (separator === -1) return null;

    return {
        username      : decoded.slice(0, separator),
        password      : decoded.slice(separator + 1),
        serveraddress : host
    };
}

/**
 * Resolve credentials for the registry the given image lives in.
 *
 * @param {String} image image reference, with or without a tag
 * @returns {Object|null} dockerode authconfig, or null when the registry is
 *                        anonymous (public Docker Hub images keep working)
 */
function resolveRegistryAuth(image) {
    const host = registryHostOf(image);

    return authFromEnv(host) || authFromConfig(host);
}

module.exports = { resolveRegistryAuth, registryHostOf };
