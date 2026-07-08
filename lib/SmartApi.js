/* eslint-disable more/no-c-like-loops */

const request = require('request-promise');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');

const PATH_TO_BRIDGE_TYPE_CONFIGS = process.env.BRIDGE_TYPE_CONFIGS_PATH || '/app/etc/bridge-type.configs';

class SmartApi {
    constructor({ domain, basePath = '/releases/bridge_types/' }) {
        this.domain = domain;
        this.basePath = basePath;
    }
    async getBridgeTypesList() {
        // Return list from local bridge-type configs instead of remote
        try {
            const dirs = await fs.readdir(PATH_TO_BRIDGE_TYPE_CONFIGS);
            return dirs;
        } catch (e) {
            const $ = cheerio.load(await request(`https://${this.domain}${this.basePath}`, { rejectUnauthorized: false }));
            const elements = $('a');
            const result = [];
            for (let i = 0; i < elements.length; i++) {
                const href = $(elements[i]).attr('href').slice(0, -1);

                if (href !== '..') result.push(href);
            }

            return result;
        }
    }
    async getBridgeTypeConfig(type) {
        // Try local update.configuration.json first
        const localPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, type, 'update.configuration.json');
        try {
            return await fs.readJSON(localPath);
        } catch (e) {
            // fallback to remote with self-signed cert allowed
            return request(`https://${this.domain}${this.basePath}${type}/2smart.configuration.json`, { json: true, rejectUnauthorized: false });
        }
    }
    getBridgeTypeFile(type, file) {
        // Try local file first
        const localPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, type, `update.${file}`);
        if (fs.existsSync(localPath)) {
            return fs.createReadStream(localPath);
        }
        return request(`https://${this.domain}${this.basePath}${type}/${file}`, { rejectUnauthorized: false });
    }
}

module.exports = SmartApi;
