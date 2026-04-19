/* eslint-disable max-len */
/* eslint-disable prefer-const */
/* eslint-disable more/no-c-like-loops */
/* eslint-disable more/force-native-methods */
/* eslint-disable guard-for-in */
/* eslint-disable no-sync */
/* eslint-disable more/no-then */
const path = require('path');
const fs = require('fs-extra');
const _ = require('underscore');
const Promise = require('bluebird');
const X = require('homie-sdk/lib/utils/X');
const { UNKNOWN_ERROR, RACE_CONDITION, VALIDATION, NOT_FOUND, CONNECTION_ERROR } = require('homie-sdk/lib/utils/errors');
const Docker = require('dockerode');
const imageParser = require('parse-docker-image-name');
const SmartApi = require('../SmartApi');
const Base = require('./Base');
const { sequelize }   = require('./../sequelize');

const DBBridgeTypes = sequelize.model('BridgeTypes');

let BridgeTypesEntity = null;

const BridgeTypesEntityType = 'BRIDGE_TYPES';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// TODO: move all process.env variables to etc/config.js file

const PATH_TO_BRIDGE_TYPE_CONFIGS = path.resolve(__dirname, '../../etc/bridge-type.configs');
const REMOTE_BRIDGE_TYPES_SYNC_INTERVAL = (process.env.REMOTE_BRIDGE_TYPES_SYNC_INTERVAL_SECONDS || 60 * 60 * 8) * 1000;
const BRIDGES_TAG = process.env.BRIDGES_TAG || 'market';

/*
updates:
icons and configs must be applied only after installing changes
*/
class BridgeTypesManager extends Base {
    constructor(props) {
        super(props);

        this.bridgeTypes = {};
        this.mutexes = {};

        this.handleRepublishRequest = this.handleRepublishRequest.bind(this);
        this.handleNewEntity = this.handleNewEntity.bind(this);
        this.synchronizing = false;

        this.remoteSynchronizing = false;
        this.remoteSyncTimeout = null;

        this.smartApi = new SmartApi({
            domain   : process.env.SMART_DOMAIN,
            basePath : process.env.SMART_BRIDGES_CONFIG_BASE_PATH
        });
        this.initialized = false;
    }
    async getBridgeTypesList() {
        return fs.readdir(PATH_TO_BRIDGE_TYPE_CONFIGS);
    }
    async getLocalBridgeType(type) {
        try {
            const bridgeTypeLocalConfPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, type, 'local.configuration.json');

            return await fs.readJSON(bridgeTypeLocalConfPath);
        } catch (e) {
            if (e.code === 'ENOENT') return null;
            throw e;
        }
    }

    async init() {
        // to delete(back compativbility)~
        const dbBridgeTypes = await DBBridgeTypes.findAll({
            where : {}
        });

        for (const { title, type, configuration, registry, icon } of dbBridgeTypes) {
            const bridgeTypeFolderPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, type);

            if (!fs.existsSync(bridgeTypeFolderPath)) {
                const bridgeType = { title, type, configuration, registry, icon };

                let image = null;
                try {
                    image = await docker.getImage(`${registry}:${BRIDGES_TAG}`).inspect();
                } catch (e) {
                    if (e.code !== 'ENOENT' && e.reason !== 'no such image') throw e;
                }

                if (image) {
                    const bridgeTypeLocalConfPath = path.resolve(bridgeTypeFolderPath, 'local.configuration.json');

                    fs.ensureDirSync(bridgeTypeFolderPath);
                    fs.writeJSONSync(bridgeTypeLocalConfPath, bridgeType);
                }
            }
        }
        // ~to delete

        this.debug.info('BridgeTypesManager.init');

        await this.core.homieMigrator.initializeEntityClass(BridgeTypesEntityType);

        BridgeTypesEntity = this.core.homie.entitiesStore.classes[BridgeTypesEntityType];
        this.rootTopic = this.core.homie.getEntityRootTopicByType(BridgeTypesEntityType);
        this.errorTopic = `${this.core.homie.errorTopic}/${this.rootTopic}`;

        this.core.homie.on(`request.${BridgeTypesEntityType}.republish`, this.handleRepublishRequest);
        this.core.homie.on('new_entity', this.handleNewEntity);

        await this.firstSync();
        await this.republish();
        if (process.env.SMART_DOMAIN) {
            await this.syncRemoteBridgeTypes();
        } else {
            this.debug.info('BridgeTypesManager.init', 'SMART_DOMAIN is empty — skipping remote bridge-types sync');
        }

        this.debug.info('BridgeTypesManager.init', 'finish');
        this.initialized = true;
        this.emit('initialized');
    }

    /**
     *  Validates each existent bridge type entity and removes non-valid
     */
    checkBridgeTypesValidity() {
        Object.keys(this.bridgeTypes).forEach(bridgeTypeId => {
            const { entity } = this.bridgeTypes[bridgeTypeId];

            if (entity) {
                try {
                    entity.validateMyStructure();
                } catch (err) {
                    this.debug.warning('BridgeTypesManager.checkBridgeTypesValidity', err);
                    delete this.bridgeTypes[bridgeTypeId];
                }
            }
        });
    }

    async handleRepublishRequest(data) {
        this.debug.info('BridgeTypesManager.handleRepublishRequest');

        try {
            await this.republish();
            await this.core.homie.response(BridgeTypesEntityType, 'republish', data);
        } catch (error) {
            this.debug.warning('BridgeTypesManager.handleRepublishRequest', error);

            if (!(error instanceof X)) {
                // eslint-disable-next-line no-param-reassign,no-ex-assign
                error = new UNKNOWN_ERROR();
            }

            try {
                this.debug.info('BridgeTypesManager.handleRepublishRequest');
                await this.core.homie.response(BridgeTypesEntityType, 'republish', { ...data, error });
            } catch (e) {
                this.debug.warning('BridgeTypesManager.handleRepublishRequest', e);
            }
        }

        this.debug.info('BridgeTypesManager.handleRepublishRequest', 'Finish!');
    }

    async handleNewEntity({ entityId, type }) {
        if (type !== BridgeTypesEntityType) return;

        this.debug.info('BridgeTypesManager.handleNewEntity');
        await this.doLockMutexAction(entityId, async () => {
            await this.syncBridgeType(entityId);
        });
    }

    async attachNewBridgeTypesEntity(entity) {
        this.debug.info('BridgeTypesManager.attachNewBridgeTypesEntity', `EntityId - ${entity.id}`);

        if (!(entity instanceof BridgeTypesEntity)) throw new Error('!(entity instanceof BridgeEntity)');
        if (!entity._isValid) {
            this.debug.warning('BridgeTypesManager.attachNewBridgeEntity', `Entity with id=${entity.id} is invalid`);

            return;
        }
        if (this.bridgeTypes[entity.id] && this.bridgeTypes[entity.id].entity) {
            this.debug.warning('BridgeTypesManager.attachNewBridgeEntity', `Entity with id=${entity.id} is already attached.`);

            return;
        }

        const homie = this.core.homie;
        const bridgeType = this.bridgeTypes[entity.id] = this.bridgeTypes[entity.id] || {};

        const handleDelete = async () => {
            const err = new UNKNOWN_ERROR('Operation is permitted.');

            await this.publishError(err, `${entity.id}/delete`);
        };

        const cleanUp = async ({ oldRegistry, registry, tag }) => {
            this.debug.info('BridgeTypesManager.attachNewBridgeTypesEntity.cleanUp', { oldRegistry, registry, tag });

            for (const image of [
                ...await docker.listImages({ filters: `{"reference": ["${oldRegistry}"]}` }),
                ...await docker.listImages({ filters: `{"reference": ["${registry}"]}` })
            ]) {
                const { RepoTags } = image;
                if (RepoTags && !RepoTags.includes(`${registry}:${tag}`)) {
                    for (const repoTag of RepoTags) {
                        try {
                            await docker.getImage(repoTag).remove();
                        } catch (e) {
                            this.debug.warning('BridgeTypesManager.attachNewBridgeTypesEntity.cleanUp', `Unable to remove image - ${repoTag}`);
                            this.debug.warning('BridgeTypesManager.attachNewBridgeTypesEntity.cleanUp', e);
                        }
                    }
                }
            }

            this.debug.info('BridgeTypesManager.attachNewBridgeTypesEntity.cleanUp', 'Finish!');
        };

        const pull = async () => {
            this.debug.info('BridgeTypesManager.attachNewBridgeTypesEntity.pull', `EntityId - ${entity.id}`);

            const bridgesManager = this.core.services.bridgesManager;
            const bridgeTypeUpdateConfPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, entity.id, 'update.configuration.json');
            const updateConfiguration = await fs.readJSON(bridgeTypeUpdateConfPath);
            const { registry, version: newVersion } = updateConfiguration;

            const parsedImageName = imageParser(bridgeType.localRegistryTag);
            const oldRegistry = `${parsedImageName.domain}/${parsedImageName.path}`;
            const tag = parsedImageName.tag;

            this.debug.info('BridgeTypesManager.attachNewBridgeTypesEntity.pull', {
                id     : entity.id,
                oldTag : tag,
                oldRegistry,
                newVersion,
                registry,
                parsedImageName
            });

            return this.doLockMutexAction(entity.id, async () => {
                this.debug.info('BridgeTypesManager.attachNewBridgeTypesEntity.pull.doLockMutexAction', `EntityId - ${entity.id}`);

                await this.core.services.bridgesManager.lockBridgeType(entity.id);
                await entity.publish({
                    status : 'pulled',
                    state  : 'pulling'
                }, false);
                const stream = await docker.pull(`${registry}:${newVersion}`);

                await new Promise((resolve) => {
                    const go = () => {
                        stream.off('close', go);
                        stream.off('end', go);
                        resolve();
                    };
                    stream.on('data', (data) => this.debug.info('BridgeTypesManager.attachNewBridgeTypesEntity.pull.stream.on.data', data.toString()));
                    stream.on('close', go);
                    stream.on('end', go);
                    stream.on('error', (e) => this.debug.error('BridgeTypesManager.attachNewBridgeTypesEntity.pull.stream.on.error', `${e.message}`));
                });
                await docker.getImage(`${registry}:${newVersion}`).tag({ repo: registry, tag });

                const bridgeTypeLocalConfPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, entity.id, 'local.configuration.json');

                if (updateConfiguration.icon) {
                    const bridgeTypeUpdateIconPath =  path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, entity.id, `update.${updateConfiguration.icon}`);
                    const bridgeTypeLocalIconPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, entity.id, updateConfiguration.icon);

                    await fs.copyFile(bridgeTypeUpdateIconPath, bridgeTypeLocalIconPath).catch(() => {});
                }

                await fs.writeJSON(bridgeTypeLocalConfPath, updateConfiguration);
                await entity.publishAttribute('state', 'pulled', false);
                await entity.publishAttribute('version', {
                    updateAvailable : false,
                    updated         : true
                });
                await this.syncBridgeType(entity.id);

                this.debug.info('BridgeTypesManager.attachNewBridgeTypesEntity.pull.doLockMutexAction', `EntityId - ${entity.id} pulled!`);
            }).then(async () => {
                // await bridgesManager.startAndUnlockBridgeType(entity.id);
                await bridgesManager.restartLockedBridgeType(entity.id);
            }, async (e) => {
                // await bridgesManager.startAndUnlockBridgeType(entity.id);
                await bridgesManager.restartLockedBridgeType(entity.id);
                throw e;
            }).then(async () => {
                await bridgesManager.unlockBridgeType(entity.id);
            }, async (e) => {
                await bridgesManager.unlockBridgeType(entity.id);
                throw e;
            }).then(async () => {
                // clean up
                await cleanUp({ oldRegistry, registry, tag });
            }).catch(async (e) => {
                await this.syncBridgeType(entity.id);
                await entity.publishAttribute('version', {
                    updateAvailable : true,
                    updated         : false,
                    updateError     : new CONNECTION_ERROR(e.statusCode ? 'Request error. Please try again later' : null)
                });
                if (e.statusCode === 404 && e.message.includes('manifest unknown')) {
                    this.debug.error(e);
                    await this.syncRemoteBridgeType(entity.id); // reload wrong update
                    throw new NOT_FOUND('Repository was not found.');
                } else throw e;
            });
        };

        const remove = async () => {
            this.debug.info('BridgeTypesManager.attachNewBridgeTypesEntity.remove', `EntityId - ${entity.id}`);

            return this.doLockMutexAction(entity.id, async () => {
                if (bridgeType.config.icon) {
                    const bridgeTypeLocalIconPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, entity.id, bridgeType.config.icon);
                    await fs.unlink(bridgeTypeLocalIconPath).catch(() => {});
                }

                const bridgeTypeLocalConfPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, entity.id, 'local.configuration.json');

                await fs.unlink(bridgeTypeLocalConfPath);
                await entity.publish({
                    status : 'removed',
                    state  : 'removing'
                }, false);

                const parsedImageName = imageParser(bridgeType.localRegistryTag);
                const reference = `${parsedImageName.domain}/${parsedImageName.path}`;
                const imagesOnHost = await docker.listImages({ filters: `{"reference": ["${reference}"]}` });

                for (const image of imagesOnHost) {
                    const { RepoTags } = image;
                    if (RepoTags) {
                        for (const repoTag of RepoTags) {
                            this.debug.info('BridgeTypesManager.attachNewBridgeTypesEntity.remove', repoTag);
                            await docker.getImage(repoTag).remove();
                        }
                    }
                }
                await entity.publishAttribute('state', 'removed', false);
                await entity.publishAttribute('version', {
                    updateAvailable : true,
                    updated         : false
                });
                await this.syncBridgeType(entity.id);
            }).catch(async (e) => {
                await this.syncBridgeType(entity.id);
                throw e;
            });
        };

        const check = async () => {
            this.debug.info('BridgeTypesManager.attachNewBridgeEntity.check');

            await this.syncRemoteBridgeType(entity.id);
            await entity.publishAttribute('version', { ...entity.version });
        };

        const eventErrorCatcher = (err) => {
            this.debug.error(err);
            this.publishEntityError(err, entity, 'event');
        };

        const handleUpdate = async (translated) => {
            try {
                if (this.mutexes[entity.id]) throw new RACE_CONDITION('BridgeType is processing now, wait for the end of operation.');

                const { value } = translated;

                if (!value.event) throw new RACE_CONDITION('Please specify \'event\' field.');

                if (value.event) {
                    if (translated.event === 'pull') {
                        pull().catch(eventErrorCatcher);
                    } else if (translated.event === 'remove') {
                        if (this.core.services.bridgesManager.checkIfBridgeTypeIsRunning(entity.id)) {
                            throw new RACE_CONDITION('You have to stop all running bridges before removing the image.');
                        }
                        remove().catch(eventErrorCatcher);
                    } else if (translated.event === 'check') await check();
                    else {
                        throw new VALIDATION({
                            fields : {
                                'event' : [ 'not_allowed_value' ]
                            },
                            message : `Value ${value.event} is not allowed for the field event.`
                        });
                    }
                }
            } catch (err) {
                await this.publishError(err, `${entity.id}/update`);
            }
        };

        const handleSet = async (translated) => {
            const key = _.keys(translated)[0];

            try {
                if (this.mutexes[entity.id]) throw new RACE_CONDITION('BridgeType is processing now, wait for the end of operation.');

                if (key === 'event') {
                    if (translated.event === 'pull') {
                        await entity.publishAttribute('event', 'pull');
                        pull().catch(eventErrorCatcher);
                    } else if (translated.event === 'remove') {
                        if (this.core.services.bridgesManager.checkIfBridgeTypeIsRunning(entity.id)) {
                            throw new RACE_CONDITION('You have to stop all running bridges before removing the image.');
                        }
                        await entity.publishAttribute('event', 'remove');
                        remove().catch(eventErrorCatcher);
                    } else if (translated.event === 'check') {
                        await check();
                        await entity.publishAttribute('event', 'check');
                    } else {
                        throw new VALIDATION({
                            fields : {
                                'event' : [ 'not_allowed_value' ]
                            },
                            message : `Value ${translated.event} is not allowed for the field ${key}.`
                        });
                    }
                } else {
                    throw new VALIDATION({
                        fields : {
                            [key] : [ 'not_allowed' ]
                        },
                        message : `You cannot set the field ${key}`
                    });
                }
            } catch (err) {
                await this.publishEntityError(err, entity, key);
            }
        };

        bridgeType.entity = entity;
        homie.on(`homie.entity.${entity.getType()}.${entity.id}.delete`, handleDelete);
        homie.on(`homie.entity.${entity.getType()}.${entity.id}.update`, handleUpdate);
        homie.on(entity._getSetEventName(), handleSet);
    }

    async waitMutex(id) {
        if (!this.mutexes[id]) return;
        await new Promise((resolve) => {
            this.once(`mutex.unlocked.${id}`, resolve);
        });
    }

    async lockMutex(id) {
        while (this.mutexes[id]) await this.waitMutex(id);
        this.mutexes[id] = { lockedAt: new Date() };
        this.emit(`mutex.locked.${id}`);
    }

    async unlockMutex(id) {
        if (this.mutexes[id]) delete this.mutexes[id];
        this.emit(`mutex.unlocked.${id}`);
    }

    async doLockMutexAction(id, action) {
        try {
            await this.lockMutex(id);
            await action();
        } catch (e) {
            await this.unlockMutex(id);
            throw e;
        }
        await this.unlockMutex(id);
    }

    async syncBridgeType(type) {
        this.debug.info('BridgeTypesManager.syncBridgeType', { type });

        const id = type;

        let localConfig = await this.getLocalBridgeType(type);
        let updateConfig = null;
        try {
            const bridgeTypeUpdateConfPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, type, 'update.configuration.json');
            updateConfig = await fs.readJSON(bridgeTypeUpdateConfPath);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }

        this.debug.info('BridgeTypesManager.syncBridgeType', { type, localConfig, updateConfig });

        const bridgeType = this.bridgeTypes[id] = this.bridgeTypes[id] || {};
        let entity = null;
        try {
            entity = this.core.homie.getEntityById(BridgeTypesEntityType, id);
            // eslint-disable-next-line no-empty
        } catch (e) {}

        if (!localConfig && !updateConfig) {
            // strange, folder is artifact?
            const bridgeTypeFolderPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, type);
            await fs.rmdir(bridgeTypeFolderPath, { recursive: true });

            if (entity) await this.core.homieMigrator.deleteEntity(entity);

            delete this.bridgeTypes[id];

            return;
        }

        let { title, configuration, registry, version } = localConfig || { ...updateConfig, configuration: {} };

        bridgeType.localRegistryTag = `${registry}:${BRIDGES_TAG}`;
        bridgeType.remoteRegistryTag = `${registry}:${version || BRIDGES_TAG}`;

        bridgeType.config = localConfig || { ...updateConfig, configuration: {} };
        let image = null;
        try {
            image = await docker.getImage(bridgeType.localRegistryTag).inspect();
        } catch (e) {
            if (e.code !== 'ENOENT' && e.reason !== 'no such image') throw e;
        }

        const status = (localConfig && image) ? 'pulled' : 'removed';
        let icon = null;
        if (localConfig && image) {
            if (localConfig.icon && localConfig.icon.split('/')[0] === 'api') icon = localConfig.icon;
            else icon = `resources/bridge-types/${type}/${localConfig.icon}`;
        } else if (updateConfig) {
            if (updateConfig.icon) icon = `resources/bridge-types/${type}/update.${updateConfig.icon}`;
        }

        this.debug.info('BridgeTypesManager.syncBridgeType', { title, type, icon });

        const entityObj = {
            title,
            configuration,
            icon,
            status,
            state   : status,
            version : {
                updateAvailable : updateConfig && (!localConfig || updateConfig.version !== localConfig.version),
                updated         : false
            }
        };

        if (!entity) {
            this.debug.info('BridgeTypesManager.syncBridgeType', `Creating new entity - ${id}`);
            entity = await this.core.homieMigrator.attachEntity(BridgeTypesEntityType, {
                id,
                ... entityObj
            });
        }

        // case when entity exists in sdk but not in core
        if (entity && !bridgeType.entity) {
            this.debug.info('BridgeTypesManager.syncBridgeType', `Attach existing entity - ${id}`);
            await this.attachNewBridgeTypesEntity(entity);
        }

        this.debug.info('BridgeTypesManager.syncBridgeType', `Entity publish - ${id}`);
        this.debug.info('BridgeTypesManager.syncBridgeType', entityObj);

        await entity.publish(entityObj);
    }

    async firstSync() {
        this.debug.info('BridgeTypesManager.firstSync', { synchronizing: this.synchronizing });

        if (this.synchronizing) return;

        this.synchronizing = true;
        try {
            const localBridgeTypesList = await this.getBridgeTypesList();

            this.debug.info('BridgeTypesManager.firstSync.getBridgeTypesList', { localBridgeTypesList });

            await Promise.all(localBridgeTypesList.map(async type => {
                const id = type;

                return this.doLockMutexAction(id, async () => {
                    await this.syncBridgeType(type);
                });
            }));
        } catch (e) {
            this.debug.warning('BridgeTypesManager.firstSync',  e);
            throw e;
        }
        this.synchronizing = false;
        this.debug.info('BridgeTypesManager.firstSync', 'Finish!');
    }

    async syncRemoteBridgeType(type) {
        this.debug.info(`BridgeTypesManager.syncRemoteBridgeType.${type}`);

        const remoteConfiguration = await this.smartApi.getBridgeTypeConfig(type);

        this.debug.info(`BridgeTypesManager.syncRemoteBridgeType.${type}`, { remoteConfiguration });

        await this.doLockMutexAction(type, async () => {
            let config = null;
            const bridgeTypeFolderPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, type);
            const bridgeTypeUpdateConfPath = path.join(bridgeTypeFolderPath, 'update.configuration.json');
            const bridgeTypeUpdateIconPath = remoteConfiguration.icon && path.join(bridgeTypeFolderPath, `update.${remoteConfiguration.icon}`);

            this.debug.info(
                `BridgeTypesManager.syncRemoteBridgeType.${type}`,
                { bridgeTypeFolderPath, bridgeTypeUpdateConfPath, bridgeTypeUpdateIconPath }
            );

            try {
                config = await fs.readJSON(bridgeTypeUpdateConfPath);
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
                config = await this.getLocalBridgeType(type);
            }

            this.debug.info(`BridgeTypesManager.syncRemoteBridgeType.${type}`, { config });

            if (!this._isUpdateRequired(config, remoteConfiguration)) return;
            await fs.ensureDir(bridgeTypeFolderPath);

            if (remoteConfiguration.icon) {
                const promise =  this.smartApi.getBridgeTypeFile(type, remoteConfiguration.icon);
                promise.pipe(fs.createWriteStream(bridgeTypeUpdateIconPath));
                await promise;
            }

            await fs.writeJSON(bridgeTypeUpdateConfPath, remoteConfiguration);
            await this.syncBridgeType(type);

            this.debug.info(`BridgeTypesManager.syncRemoteBridgeType.${type}`, 'Finish!');
        });
    }

    _isUpdateRequired(localConfig, remoteConfig) {
        this.debug.info('BridgeTypesManager._isUpdateRequired', { localConfig, remoteConfig });
        try {
            // install or update is required
            if (!localConfig) return true;

            // new version released
            if (remoteConfig.version !== localConfig.version) return true;

            // new docker registry
            if (remoteConfig.registry !== localConfig.registry) return true;
        } catch (e) {
            this.debug.warning('BridgeTypesManager._isUpdateRequired', e);
        }

        return false;
    }

    async syncRemoteBridgeTypes() {
        this.debug.info('BridgeTypesManager.syncRemoteBridgeTypes');

        if (!process.env.SMART_DOMAIN) {
            this.debug.info('BridgeTypesManager.syncRemoteBridgeTypes', 'SMART_DOMAIN is empty — skipping remote sync');

            return;
        }

        if (this.remoteSynchronizing) return;

        clearTimeout(this.remoteSyncTimeout);
        this.remoteSynchronizing = true;
        const localbridges_hash = {};

        for (const type of await this.getBridgeTypesList()) localbridges_hash[type] = true;

        this.debug.info('BridgeTypesManager.syncRemoteBridgeTypes', { localbridges_hash });

        try {
            for (const type of await this.smartApi.getBridgeTypesList()) {
                this.debug.info('BridgeTypesManager.syncRemoteBridgeTypes.smartApi.getBridgeTypesList', { type });

                try {
                    delete localbridges_hash[type];
                    await this.syncRemoteBridgeType(type);
                } catch (e) {
                    this.debug.warning('BridgeTypesManager.syncRemoteBridgeTypes',  e);
                }
            }

            for (const type of Object.keys(localbridges_hash)) {
                await this.doLockMutexAction(type, async () => {
                    try {
                        const bridgeTypeUpdateConfPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, type, 'update.configuration.json');
                        const { icon } = await fs.readJSON(bridgeTypeUpdateConfPath);

                        if (icon) {
                            const bridgeTypeUpdateIconPath = path.join(PATH_TO_BRIDGE_TYPE_CONFIGS, type, `update.${icon}`);
                            await fs.unlink(bridgeTypeUpdateIconPath).catch(() => {});
                        }

                        await fs.unlink(bridgeTypeUpdateConfPath);
                    } catch (e) {
                        if (e.code !== 'ENOENT') throw e;
                    }
                    await this.syncBridgeType(type);
                });
            }
        } catch (e) {
            this.debug.warning('BridgeTypesManager.syncRemoteBridgeTypes',  e);
        }

        this.remoteSynchronizing = false;
        this.remoteSyncTimeout = setTimeout(this.syncRemoteBridgeTypes.bind(this), REMOTE_BRIDGE_TYPES_SYNC_INTERVAL);

        this.debug.info('BridgeTypesManager.syncRemoteBridgeTypes', 'Finish!');
    }

    async republish() {
        this.debug.info('BridgeTypesManager.republish');
        this.checkBridgeTypesValidity();

        return Promise.all(_.keys(this.bridgeTypes).map(async (id) => {
            const { entity } = this.bridgeTypes[id];

            if (entity) {
                await entity.publish(_.without(entity.getAttributesList(), 'event'), true);

                this.debug.info('BridgeTypesManager.republish', {
                    type          : entity.id,
                    title         : entity.title,
                    configuration : entity.configuration,
                    icon          : entity.icon,
                    status        : entity.status,
                    state         : entity.state,
                    version       : entity.version
                });
            }
        }));
    }

    async publishError(error, topic) {
        try {
            if (!(error instanceof X)) {
                this.debug.error(error);
                // eslint-disable-next-line no-param-reassign
                error = new UNKNOWN_ERROR();
            }

            this.debug.warning('BridgeTypesManager.publishError', {
                code    : error.code,
                fields  : error.fields,
                message : error.message
            });

            this.core.homie.publishToBroker(`${this.errorTopic}/${topic}`, JSON.stringify(error), { retain: false });
        } catch (e) {
            this.debug.warning('BridgeTypesManager.publishError', e);
        }
    }

    async publishEntityError(error, entity, key) {
        try {
            if (!(error instanceof X)) {
                this.debug.error(error);
                // eslint-disable-next-line no-param-reassign
                error = new UNKNOWN_ERROR();
            }

            this.debug.warning('BridgeTypesManager.publishEntityError', {
                code    : error.code,
                fields  : error.fields,
                message : error.message
            });

            await entity.publishError(key, error);
        } catch (e) {
            this.debug.warning('BridgeTypesManager.publishEntityError', e);
        }
    }

    async isImageExist(id) {
        const bridgeType = this.bridgeTypes[id];

        if (!bridgeType) return false;

        try {
            await docker.getImage(bridgeType.localRegistryTag).inspect();
        } catch (e) {
            return false;
        }

        return true;
    }
}


module.exports = BridgeTypesManager;
