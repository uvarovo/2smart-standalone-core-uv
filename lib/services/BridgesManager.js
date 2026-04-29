/* eslint-disable more/force-native-methods */
/* eslint-disable guard-for-in */
/* eslint-disable no-sync */
/* eslint-disable more/no-then */
const { once } = require('events');
const path = require('path');
const _ = require('underscore');
const envfile = require('envfile');
const Promise = require('bluebird');
const fs = require('fs-extra');
const imageParser = require('parse-docker-image-name');
const X = require('homie-sdk/lib/utils/X');
const { EXISTS, UNKNOWN_ERROR, RACE_CONDITION, VALIDATION } = require('homie-sdk/lib/utils/errors');
const LIVR = require('livr');
const Docker = require('dockerode');
const Base = require('./Base');


let BridgeEntity = null;

const BridgeEntityType = 'BRIDGE';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const PATH_TO_BRIDGE_CONFIGS = path.resolve(__dirname, '../../etc/bridge.configs');
const PATH_TO_SHARED_DIR = path.resolve(__dirname, '../../etc/shared'); // shared dir between multiple containers
const BRIDGE_CONFIG_DIR_PATH = '/etc';
const BRIDGE_CLEAR_TIMEOUT = 10 * 60 * 1000;

let DOCKER_COMPOSER_PROJECT = null;
let DEFAULT_NETWORK = null;

const STREAM_EVENT_REGEX = new RegExp('@event::(.+)::@end', 'g');
// Names of containers created by bridge manager must start with this prefixes
const CONTAINER_PREFIXES = {
    bridge  : 'bridge',
    service : 'service'
};

const {
    HOST_MAIN_PATH,
    BRIDGES_TAG,
    MQTT_URI,
    TZ
} = process.env;

class BridgesManager extends Base {
    constructor(props) {
        super(props);

        this.handleBridgeCreateEvent = this.handleBridgeCreateEvent.bind(this);
        this.handleNewEntity = this.handleNewEntity.bind(this);
        this.bridges = {};
        this.mutexes = {};
        this.rootTopic = undefined;
        this.errorTopic = undefined;
        this.lockedBridgeTypes = {};

        this.bridgeStreamHandlers = {
            'reloadNginx' : this._reloadNginxContainer.bind(this)
        };
    }

    async init() {
        if (!this.core.services.bridgeTypesManager.initialized) {
            await once(this.core.services.bridgeTypesManager, 'initialized');
        }
        this.debug.info('BridgesManager.init');

        BridgeEntity = this.core.homie.entitiesStore.classes[BridgeEntityType];
        const { Config, NetworkSettings } = await docker.getContainer('2smart-core').inspect();

        DOCKER_COMPOSER_PROJECT = Config.Labels['com.docker.compose.project'];
        DEFAULT_NETWORK = Object.keys(NetworkSettings.Networks)[0];

        this.rootTopic = this.core.homie.getEntityRootTopicByType(BridgeEntityType);
        this.errorTopic = `${this.core.homie.errorTopic}/${this.rootTopic}`;

        this.debug.info('BridgesManager.init', 'listContainers');

        await docker.listContainers({ all: true }).then(async (containersInfo) => {
            await Promise.all(containersInfo.map(async (containerInfo) => {
                if (!containerInfo.Names.length) return;
                let name = containerInfo.Names[containerInfo.Names.length - 1];

                if (!name) return;
                name = name.substring(1); // get the container name without "/"
                const parsedName = name.split('-');
                const prefix = parsedName.shift();
                const isPrefixValid = Object.values(CONTAINER_PREFIXES).includes(prefix);

                if (isPrefixValid) {
                    const id = parsedName.pop();
                    let type;

                    try {
                        const entity = this.core.homie.getEntityById(BridgeEntityType, id);
                        type = entity.type;
                    } catch (err) {
                        this.debug.warning('BridgesManager.init.listContainers', err);
                    }

                    await this.doLockMutexAction(id, async () => {
                        if (this.bridges[id]) { // we have a duplication
                            try {
                                await docker.getContainer(this.bridges[id].containerInfo.Id).remove();
                            } catch (e) {
                                this.debug.warning('BridgesManager.init.listContainers', e);
                            }
                        }

                        this.bridges[id] = { type, containerInfo, entity: null };
                    });
                }
            }));
        });

        this.debug.info('BridgesManager.init', 'scan bridges dir');

        await Promise.each(fs.readdirSync(PATH_TO_BRIDGE_CONFIGS), async (containerName) => {
            const parsedName = containerName.split('-');
            const prefix = parsedName.shift();
            const isPrefixValid = Object.values(CONTAINER_PREFIXES).includes(prefix);

            if (isPrefixValid) {
                const id = parsedName.pop();
                let type;

                try {
                    const entity = this.core.homie.getEntityById(BridgeEntityType, id);
                    type = entity.type;
                } catch (err) {
                    this.debug.warning('BridgesManager.init.listContainers', err);
                }

                await this.doLockMutexAction(id, async () => {
                    this.bridges[id] = this.bridges[id] || {};
                    if (this.bridges[id].type && this.bridges[id].type !== type) {
                        this.debug.warning('BridgesManager.init', 'on init container.type!==fs.type');

                        try {
                            await this.removeConfiguration({ id, type });
                        } catch (e) {
                            this.debug.warning('BridgesManager.init.removeConfiguration', e);
                        }

                        return;
                    }
                    this.bridges[id].type = type;
                });
            }
        });

        this.debug.info('BridgesManager.init', 'get entities');

        const entities = this.core.homie.getEntities(BridgeEntityType);

        for (const id in entities) {
            await this.doLockMutexAction(id, async () => {
                await this.attachNewBridgeEntity(entities[id]);
            });
        }

        this.debug.info('BridgesManager.init', 'handlers');

        this.core.homie.on('homie.entity.BRIDGE.create', this.handleBridgeCreateEvent);
        this.core.homie.on('new_entity', this.handleNewEntity);
        this.core.homie.on('online', this.handleHomieConnect);

        this.debug.info('BridgesManager.init', 'sync containers');

        setTimeout(this.clearRunningBridgesWithoutEntities.bind(this), BRIDGE_CLEAR_TIMEOUT);

        this.debug.info('BridgesManager.init', 'finish');
    }

    async clearRunningBridgesWithoutEntities() {
        this.debug.info('BridgesManager.clearRunningBridgesWithoutEntities');
        await Promise.all(_.keys(this.bridges).map(async (id) => {
            if (this.bridges[id] && !this.bridges[id].entity) {
                try {
                    await this.doLockMutexAction(id, async () => {
                        if (!this.bridges[id] || this.bridges[id].entity) return;
                        this.debug.info('BridgesManager.clearRunningBridgesWithoutEntities 2', id);
                        await this.getRidOfTheContainer(id);
                    });
                } catch (e) {
                    this.debug.warning('BridgesManager.init.doLockBridgeAction', e);
                }
            }
        }));
    }

    async retrieveBridgeType(type) {
        return this.core.services.bridgeTypesManager.bridgeTypes[type].config;
    }

    getContainerName(type, id) {
        try {
            const bridgeType = this.core.services.bridgeTypesManager.bridgeTypes[type].config.configuration;

            return bridgeType.exposePort ?
                `${CONTAINER_PREFIXES.service}-${id}` :
                `${CONTAINER_PREFIXES.bridge}-${type}-${id}`;
        } catch (err) {
            this.debug.warning('BridgesManager.getContainerName', err);

            return null;
        }
    }

    async stopLockedBridgeType(type) {
        if (!this.lockedBridgeTypes[type]) throw new Error(`Bridge type ${type} is not locked.`);
        await Promise.all(_.keys(this.bridges).map(async (id) => {
            const bridge = this.bridges[id];

            if (!bridge.entity) return;
            if (bridge.entity.type !== type) return;

            await bridge.stop();
        }));
    }

    async checkLockedBridgeType(type) {
        if (!this.lockedBridgeTypes[type]) throw new Error(`Bridge type ${type} is not locked.`);
        await Promise.all(_.keys(this.bridges).map(async (id) => {
            const bridge = this.bridges[id];

            if (!bridge.entity) return;
            if (bridge.entity.type !== type) return;

            await bridge.checkState();
            try {
                await this.checkContainer(bridge.entity.id);
            } catch (e) {
                this.debug.warning('BridgesManager.checkLockedBridgeType', e);
            }
        }));
    }

    async restartLockedBridgeType(type) {
        if (!this.lockedBridgeTypes[type]) throw new Error(`Bridge type ${type} is not locked.`);
        await Promise.all(_.keys(this.bridges).map(async (id) => {
            const bridge = this.bridges[id];

            if (!bridge.entity) return;
            if (bridge.entity.type !== type) return;

            await bridge.stop();
            await bridge.checkState();
            try {
                await this.checkContainer(bridge.entity.id);
            } catch (e) {
                this.debug.warning('BridgesManager.restartLockedBridgeType', e);
            }
        }));
    }

    async lockBridgeType(type) {
        this.lockedBridgeTypes[type] = true;
        await Promise.all(_.keys(this.bridges).map(async (id) => {
            const bridge = this.bridges[id];

            if (!bridge.entity) return;
            if (bridge.entity.type !== type) return;

            await this.lockMutex(bridge.entity.id);
        }));
    }

    async unlockBridgeType(type) {
        await Promise.all(_.keys(this.bridges).map(async (id) => {
            const bridge = this.bridges[id];

            if (!bridge.entity) return;
            if (bridge.entity.type !== type) return;

            await this.unlockMutex(bridge.entity.id);
        }));
        delete this.lockedBridgeTypes[type];
    }

    checkIfBridgeTypeIsRunning(type) {
        for (const id in this.bridges) {
            const bridge = this.bridges[id];

            if (!bridge.entity) continue;
            if (bridge.entity.type !== type) continue;

            if (bridge.entity.status === 'started') return true;
        }

        return false;
    }

    async handleHomieConnect() {
        for (const id in this.bridges) {
            await this.doLockMutexAction(id, async () => {
                try {
                    await this.checkContainer(id);
                } catch (e) {
                    this.debug.warning('BridgesManages.handleHomieConnect', e);
                }
            });
        }
    }

    async handleBridgeCreateEvent(options) {
        try {
            const {
                translated,
                entityId
            } = options;
            const { value } = translated;

            this.debug.info('BridgesManager.handleBridgeCreateEvent', translated);
            let entity = null;

            try {
                entity = this.core.homie.getEntityById(BridgeEntityType, entityId);
                // eslint-disable-next-line no-empty
            } catch (e) {}
            if (entity) {
                throw new EXISTS({
                    fields : {
                        'entityId' : [ 'exists' ]
                    },
                    message : 'EntityId is already in use. Try again later.'
                });
            }

            if (!this.core.services.bridgeTypesManager.isImageExist(value.type)) throw new UNKNOWN_ERROR(`Bridge type ${value.type} is not pulled.`);
            await this.validateBridgeConriguration(value);

            await this.doLockMutexAction(entityId, async () => {
                await this.saveConfiguration({ id: entityId, type: value.type }, value.configuration);
                entity = await this.core.homieMigrator.attachEntity(BridgeEntityType, { state: 'stopped', ...value, id: entityId });

                await this.attachNewBridgeEntity(entity);
            });
        } catch (err) {
            await this.publishError(err, `${options.entityId}/create`);
        }
    }

    async handleNewEntity({ entityId, type }) {
        if (type !== BridgeEntityType) return;
        let entity = null;

        try {
            entity = this.core.homie.getEntityById(BridgeEntityType, entityId);
        } catch (e) {
            this.debug.warning('BridgesManager.handleNewEntity', e);

            return;
        }

        await this.doLockMutexAction(entityId, async () => {
            await this.attachNewBridgeEntity(entity);
        });
    }

    async attachNewBridgeEntity(entity) {
        this.debug.info('BridgesManager.attachNewBridgeEntity', `EntityId - ${entity.id}`);

        if (!(entity instanceof BridgeEntity)) throw new Error('!(entity instanceof BridgeEntity)');
        if (!entity._isValid) {
            this.debug.warning('BridgesManager.attachNewBridgeEntity', `Entity with id=${entity.id} is invalid`);

            return;
        }
        if (this.bridges[entity.id] && this.bridges[entity.id].entity) {
            this.debug.warning('BridgesManager.attachNewBridgeEntity', `Entity with id=${entity.id} is already attached`);

            return;
        }

        const homie = this.core.homie;
        const handleDelete = async () => {
            try {
                if (this.mutexes[entity.id]) {
                    this.debug.warning('BridgesManager.attachNewBridgeEntity', 'Bridge is processing now, wait for the end of operation');
                    throw new RACE_CONDITION('Bridge is processing now, wait for the end of operation.');
                }
                await this.doLockMutexAction(entity.id, async () => {
                    if (!this.bridges[entity.id]) return;
                    await _delete();
                });
            } catch (err) {
                await this.publishError(err, `${entity.id}/delete`);
            }
        };
        const _delete = async () => {
            await stop();
            await this.getRidOfTheContainer(entity.id);
            await this.removeConfiguration(entity);
            if (!entity.type) throw new Error('!entity.type = true');
            try {
                await this.core.services.aclManager.unregister(entity.id);
            } catch (err) {
                if (err.message !== `Cannot find a user with username=${entity.id}`) throw err;
            }
            await this.core.homieMigrator.deleteEntity(entity);
            delete this.bridges[entity.id];

            homie.off(`homie.entity.${entity.getType()}.${entity.id}.delete`, handleDelete);
            homie.off(`homie.entity.${entity.getType()}.${entity.id}.update`, handleUpdate);
            homie.off(entity._getSetEventName(), handleSet);
        };
        const start = async () => {
            if (!this.core.services.bridgeTypesManager.isImageExist(entity.type)) throw new UNKNOWN_ERROR(`Bridge type ${entity.type} is not pulled.`);
            const state = entity.getAttribute('state');

            if (state !== 'starting' && state !== 'started') await entity.publishAttribute('state', 'starting', false);
            await this.checkContainer(entity.id);
        };
        const stop = async () => {
            const state = entity.getAttribute('state');

            if (state !== 'stopping' && state !== 'stopped') await entity.publishAttribute('state', 'stopping', false);
            await this.checkContainer(entity.id);
        };
        const setConfiguration = async (configuration) => {
            await this.validateBridgeConriguration({ type: entity.type, configuration });
            await stop();
            await this.saveConfiguration(entity, configuration);
            await entity.publishAttribute('configuration', configuration, true);
            await checkState();
            await this.checkContainer(entity.id);
        };
        const checkState = async () => {
            if (entity.status === 'stopped') {
                if (entity.state !== 'stopping' && entity.state !== 'stopped') await entity.publishAttribute('state', 'stopping', false);
            } else if (entity.status === 'started') {
                if (entity.state !== 'starting' && entity.state !== 'started') await entity.publishAttribute('state', 'starting', false);
            }
        };
        const checkStatus = async () => {
            if (entity.state === 'stopping' || entity.state === 'stopped') await entity.publishAttribute('status', 'stopped', false);
            else if (entity.state === 'starting' || entity.state === 'started') await entity.publishAttribute('status', 'started', false);
        };
        const handleUpdate = async (translated) => {
            try {
                if (this.mutexes[entity.id]) throw new RACE_CONDITION('Bridge is processing now, wait for the end of operation.');
                await this.doLockMutexAction(entity.id, async () => {
                    if (!this.bridges[entity.id]) throw new Error('Bridge has been deleted.');
                    const { value } = translated;

                    if (!value.configuration  && !value.event) throw new VALIDATION('Please specify either \'configuration\' or/and \'event\' field.');

                    if (value.configuration) await setConfiguration(value.configuration);

                    if (value.event) {
                        if (value.event === 'start') {
                            if (this.lockedBridgeTypes[entity.type]) throw new RACE_CONDITION(`Bridge type ${entity.type} is locked now, wait for the end of operation.`);

                            await entity.publishAttribute('status', 'started', false);
                            await start().catch(async (e) => {
                                await checkStatus();
                                throw e;
                            });
                        } else if (value.event === 'stop') {
                            await entity.publishAttribute('status', 'stopped', false);
                            await stop().catch(async (e) => {
                                await checkStatus();
                                throw e;
                            });
                        } else {
                            throw new VALIDATION({
                                fields : {
                                    'event' : [ 'not_allowed_value' ]
                                },
                                message : `Value ${value.event} is not allowed for the field event.`
                            });
                        }
                    }
                });
            } catch (err) {
                await this.publishError(err, `${entity.id}/update`);
            }
        };
        // eslint-disable-next-line func-style
        const handleSet = async (translated) => {
            const key = _.keys(translated)[0];

            try {
                if (this.mutexes[entity.id]) throw new RACE_CONDITION('Bridge is processing now, wait for the end of operation.');

                await this.doLockMutexAction(entity.id, async () => {
                    if (!this.bridges[entity.id]) throw new Error('Bridge has been deleted.');
                    if (key === 'configuration') {
                        let configuration = translated.configuration;

                        if (typeof configuration === 'string') configuration = JSON.parse(configuration);
                        await setConfiguration(configuration);
                    } else if (key === 'event') {
                        if (translated.event === 'start') {
                            if (this.lockedBridgeTypes[entity.type]) throw new RACE_CONDITION(`Bridge type ${entity.type} is locked now, wait for the end of operation.`);

                            await entity.publishAttribute('status', 'started', false);
                            await start().catch(async (e) => {
                                await checkStatus();
                                throw e;
                            });
                            await entity.publishAttribute('event', 'start');
                        } else if (translated.event === 'stop') {
                            await entity.publishAttribute('status', 'stopped', false);
                            await stop().catch(async (e) => {
                                await checkStatus();
                                throw e;
                            });
                            await entity.publishAttribute('event', 'stop');
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
                });
            } catch (err) {
                await this.publishEntityError(err, entity, key);
            }
        };
        const bridge = this.bridges[entity.id] = this.bridges[entity.id] || {};

        bridge.entity = entity;
        bridge.start = start;
        bridge.stop = stop;
        bridge.delete = _delete;
        bridge.checkState = checkState;
        homie.on(`homie.entity.${entity.getType()}.${entity.id}.delete`, handleDelete);
        homie.on(`homie.entity.${entity.getType()}.${entity.id}.update`, handleUpdate);
        homie.on(entity._getSetEventName(), handleSet);

        // fix empty entity status
        if (!entity.status) {
            try {
                this.debug.info('BridgesManager.attachNewBridgeEntity', `checkStatus - ${entity.id}`);
                await checkStatus();
            } catch (e) {
                this.debug.warning('BridgesManager.attachNewBridgeEntity', e);
            }
        }

        try {
            this.debug.info('BridgesManager.attachNewBridgeEntity', `checkState - ${entity.id}`);
            await checkState();
        } catch (e) {
            this.debug.warning('BridgesManager.attachNewBridgeEntity', e);
        }

        try {
            await this.checkContainer(entity.id);
        } catch (e) {
            this.debug.warning('BridgesManager.attachNewBridgeEntity.checkContainer', e);
        }

        this.debug.info('BridgesManager.attachNewBridgeEntity', `Finish - ${entity.id}`);
    }

    async attachContainer(id) {
        this.debug.info('BridgesManager.attachContainer', `${id}`);

        const bridge = this.bridges[id] || {};
        const entity = bridge.entity;
        const containerName = this.getContainerName(entity.type, entity.id);

        if (bridge.attaching || bridge.attached) return;

        bridge.attaching = true;

        await docker.getContainer(containerName).inspect().then((info) => {
            bridge.containerInfo = info;
        }, () => {
            bridge.containerInfo = null;
        });

        if (!bridge.containerInfo || bridge.containerInfo.State.Status !== 'running') {
            if (entity.state !== 'stopped') await entity.publishAttribute('state', 'stopped', false);

            bridge.attaching = false;
            await this.getRidOfTheContainer(id);

            return;
        }

        try {
            const stream = await docker.getContainer(containerName).attach({
                stream : true,
                stdout : true,
                stderr : true
            });

            /**
             * Handle steam events from running containers
             * To trigger event container should print to stdout message "@event::<event_name>::@end"
             */
            const onData = async buffer => {
                const data = buffer.toString();
                const match = STREAM_EVENT_REGEX.exec(data);

                // cut event name and emit
                if (match && match[1]) {
                    this.debug.info('BridgesManager.attachContainer.onData', `Emmiting event - ${match[1]} from container - ${id}`);
                    this.emit(`${id}.${match[1]}`);
                }
            };

            // eslint-disable-next-line func-style
            const detach = async () => {
                this._unsubscribeBridgeFromStreamEvents(id);
                stream.off('data', onData);
                stream.off('end', onEnd);
                stream.off('error', onError);
                bridge.detach = null;
                bridge.attached = false;
            };

            // If the container has a restart policy, the kernel/dockerd may already be
            // restarting the underlying process when our attach stream ends. In that
            // case we want to re-attach to the new process rather than tearing the
            // container down. Returns true when re-attach was scheduled.
            const reattachIfRestarting = async () => {
                try {
                    const info = await docker.getContainer(containerName).inspect();
                    const policy = info && info.HostConfig && info.HostConfig.RestartPolicy && info.HostConfig.RestartPolicy.Name;
                    const status = info && info.State && info.State.Status;

                    if (!policy || policy === 'no') return false;
                    if (status !== 'restarting' && status !== 'running') return false;

                    this.debug.info('BridgesManager.attachContainer.reattach', `Container ${containerName} is ${status} with restart policy ${policy}; will re-attach when running.`);
                    bridge.containerInfo = info;

                    // attachContainer only attaches when status==='running', so if we're
                    // still in 'restarting' we must wait until Docker promotes us. Poll
                    // every 500ms up to 30s. If the container stays stuck or gets removed,
                    // fall back to the cleanup path by returning false.
                    const waitUntilRunning = async () => {
                        for (let i = 0; i < 60; i += 1) {
                            try {
                                const cur = await docker.getContainer(containerName).inspect();
                                const cs = cur && cur.State && cur.State.Status;
                                if (cs === 'running') return true;
                                if (cs === 'exited' || cs === 'dead' || cs === 'removing') return false;
                            } catch (e) {
                                if (e && e.reason === 'no such container') return false;
                            }
                            await new Promise((res) => setTimeout(res, 500));
                        }
                        return false;
                    };

                    setImmediate(async () => {
                        try {
                            const ok = await waitUntilRunning();
                            if (ok) {
                                await this.attachContainer(id);
                            } else {
                                this.debug.warning('BridgesManager.attachContainer.reattach', `Container ${containerName} did not return to running state in time; cleaning up.`);
                                try {
                                    await entity.publish({ status: 'stopped', state: 'stopped' });
                                } catch (e) {
                                    this.debug.warning('BridgesManager.attachContainer.reattach', e);
                                }
                                await this.getRidOfTheContainer(id);
                            }
                        } catch (err) {
                            this.debug.warning('BridgesManager.attachContainer.reattach', err);
                        }
                    });
                    return true;
                } catch (e) {
                    if (e && e.reason !== 'no such container') {
                        this.debug.warning('BridgesManager.attachContainer.reattach', e);
                    }
                }
                return false;
            };

            // eslint-disable-next-line func-style
            const onError = async () => {
                this.debug.info('BridgesManager.attachContainer.onError', `${id}`);

                await detach();

                if (await reattachIfRestarting()) return;

                try {
                    await entity.publish({ status: 'stopped', state: 'stopped' });
                } catch (e) {
                    this.debug.warning('BridgesManager.attachContainer.onError', e);
                }

                await this.getRidOfTheContainer(id);
            };

            // eslint-disable-next-line func-style
            const onEnd = async () => {
                this.debug.info('BridgesManager.attachContainer.onEnd', `${id}`);

                await detach();

                if (await reattachIfRestarting()) return;

                try {
                    await entity.publish({ status: 'stopped', state: 'stopped' });
                } catch (e) {
                    this.debug.warning('BridgesManager.attachContainer.onEnd', e);
                }
                await this.getRidOfTheContainer(id);
            };

            this.debug.info('BridgesManager.attachContainer', `Finish ${id}`);

            this._subscribeBridgeToStreamEvents(id);
            stream.on('data', onData);
            stream.on('end', onEnd);
            stream.on('error', onError);
            bridge.attaching = false;
            bridge.attached = true;
            bridge.detach = detach;
        } catch (e) {
            this.debug.error(e);
        }
    }

    async checkContainer(id, forceRecreation = false) {
        this.debug.info('BridgesManager.checkContainer', `${id}`);

        try {
            const bridge = this.bridges[id];

            if (bridge.checking) return;

            bridge.checking = true;

            const { entity } = bridge;
            const state = entity.getAttribute('state');
            const type = entity.getAttribute('type');
            const configuration = entity.getAttribute('configuration');

            const containerName = this.getContainerName(type, entity.id);
            const dir = path.join(PATH_TO_BRIDGE_CONFIGS, containerName);

            if (state === 'starting' || state === 'started') {
                this.debug.info('BridgesManager.checkContainer', `Bridge ${id} ${state}`);

                const bridgeType = await this.retrieveBridgeType(type);

                let containerImage = bridgeType.registry;
                const parsedImage = imageParser(bridgeType.registry);

                if (!parsedImage.tag) {
                    containerImage = `${containerImage}:${BRIDGES_TAG || 'market'}`;
                }

                this.debug.info('BridgesManager.checkContainer', `Bridge ${id} ${state} 2`);

                if (forceRecreation || await this.isConfigurationChanged(entity, configuration)) {
                    this.debug.info('BridgesManager.checkContainer', `Bridge ${id} changed`);

                    await this.getRidOfTheContainer(entity.id);
                    await this.saveConfiguration(entity, configuration);
                }

                bridge.streamEvents = bridgeType.configuration.streamEvents || undefined;

                // container should be started
                await entity.publishAttribute('state', 'starting', false);
                await docker.getContainer(containerName).inspect().then((containerInfo) => {
                    bridge.containerInfo = containerInfo;
                }, () => {
                    bridge.containerInfo = null;
                });

                if (!bridge.containerInfo) {
                    this.debug.info('BridgesManager.checkContainer', `Container - ${containerName} not found. Creating...`);

                    const envData = envfile.parseFileSync(path.join(dir, '.env'));

                    // define the default env variables for all containers
                    envData.TZ = TZ; // timezone
                    envData.SERVICE_ID = entity.id; // service id in the system

                    const env = _.keys(envData).map((key) => `${key}=${envData[key]}`);

                    const Binds = [];
                    const Volumes = {};
                    const ExposedPorts = {};
                    const PortBindings = {};

                    bridge.sharedVolumes = [];

                    // eslint-disable-next-line no-shadow
                    for (const { name, type, exposed_port_protocol } of bridgeType.configuration.fields) {
                        if (type === 'javascript') {
                            Binds.push(`${path.join(HOST_MAIN_PATH, 'system/bridges', `./${containerName}/${name}.js`)}:${BRIDGE_CONFIG_DIR_PATH}/${name}.js`);
                            Volumes[`${BRIDGE_CONFIG_DIR_PATH}/${name}.js`] = {};
                        }

                        if (type === 'json' || type === 'modbus-config') {
                            Binds.push(`${path.join(HOST_MAIN_PATH, 'system/bridges', `./${containerName}/${name}.json`)}:${BRIDGE_CONFIG_DIR_PATH}/${name}.json`);
                            Volumes[`${BRIDGE_CONFIG_DIR_PATH}/${name}.json`] = {};
                        }

                        if (type === 'exposed-port') {
                            ExposedPorts[`${configuration[name]}/${exposed_port_protocol || 'tcp'}`] = {};
                            PortBindings[`${configuration[name]}/${exposed_port_protocol || 'tcp'}`] = [
                                {
                                    'HostIp'   : '',
                                    'HostPort' : `${configuration[name]}`
                                }
                            ];
                        }
                    }
                    const additional_volumes = (bridgeType.configuration.volumes || {});
                    const regexpBridge = /^(\{(.+)\}\/)/;

                    for (let from in additional_volumes) {
                        const to = additional_volumes[from];
                        const matchFrom = regexpBridge.exec(from);

                        let volumeType = 'HOST_ABSOLUTE';

                        if (matchFrom) volumeType = matchFrom[2]; // {BRIDGE}/conf -> matchFrom[2] = BRIDGE
                        if (from[0] === '.') volumeType = 'HOST_RELATIVE';

                        switch (volumeType) {
                            case 'BRIDGE':
                                from = path.join(HOST_MAIN_PATH, './system/bridges', containerName, from.slice(matchFrom[1].length));
                                break;
                            case 'SHARED': {
                                const dirName = from.slice(matchFrom[1].length);

                                from = path.join(HOST_MAIN_PATH, './system/shared', dirName);
                                bridge.sharedVolumes.push(dirName);
                                break;
                            }
                            case 'HOST_RELATIVE':
                                from = path.join(HOST_MAIN_PATH, from);
                                break;
                            default:
                                break;
                        }

                        Binds.push(`${from}:${to}`);
                        Volumes[to] = {};
                    }

                    const networkMode = bridgeType.configuration.network_mode;

                    const containerConfig = {
                        Image        : containerImage,
                        name         : containerName,
                        Env          : env,
                        Volumes,
                        ExposedPorts,
                        'HostConfig' : {
                            'NetworkMode' : networkMode || DEFAULT_NETWORK,
                            Binds,
                            PortBindings,
                            'LogConfig'   : {
                                'Type'   : 'json-file',
                                'Config' : {
                                    'max-file' : '5',
                                    'max-size' : '20m'
                                }
                            },
                            // Auto-restart bridges that crash or exit (e.g. KNX bridge watchdog
                            // exits when it can't reach the gateway, so it gets a fresh UDP
                            // socket on the next start). Without this, a bridge that exits
                            // stays dead until the user manually restarts the container.
                            'RestartPolicy' : { 'Name': 'unless-stopped' },
                            Sysctls : networkMode === 'host' ? null : {
                                'net.ipv4.tcp_keepalive_time'   : '60',
                                'net.ipv4.tcp_keepalive_intvl'  : '10',
                                'net.ipv4.tcp_keepalive_probes' : '4'
                            },
                            Privileged : bridgeType.configuration.privileged || false
                        },
                        Labels : {
                            'com.docker.compose.project' : DOCKER_COMPOSER_PROJECT,
                            'com.docker.compose.service' : containerName
                        }
                    };

                    this.debug.info('BridgesManager.checkContainer', `Container config - ${JSON.stringify(containerConfig)}`);

                    bridge.type = type;
                    bridge.containerInfo = await docker.createContainer(containerConfig);

                    this.debug.info('BridgesManager.checkContainer', `Container created for bridge - ${id}`);
                    bridge.containerInfo = await docker.getContainer(containerName).inspect();
                }
                if (bridge.containerInfo.State.Status !== 'running') await docker.getContainer(containerName).start();

                await entity.publishAttribute('state', 'started', false);
                await this.attachContainer(id);
            } else {
                this.debug.info('BridgesManager.checkContainer', `Stop container with bridge - ${id}`);

                if (bridge.containerInfo) {
                    await entity.publishAttribute('state', 'stopping', false);
                    await this.getRidOfTheContainer(id);
                }

                await entity.publishAttribute('state', 'stopped', false);
            }
        } catch (err) {
            if (this.bridges[id]) this.bridges[id].checking = false;

            this.debug.warning('BridgesManager.checkContainer', err);

            const bridge = this.bridges[id];
            const entity = bridge && bridge.entity;

            if (err.reason === 'no such container') {
                await entity.publish({ status: 'stopped', state: 'stopped' });
                throw new UNKNOWN_ERROR(`Bridge type ${entity.type} is not pulled.`);
            } else if (err.reason === 'container already stopped') {
                await entity.publish({ status: 'stopped', state: 'stopped' });
            } else if (entity.state === 'stopping' || entity.state === 'starting') {
                await entity.publish({ status: 'stopped', state: 'stopped' });
            }

            // throw
            throw err;
        }

        if (this.bridges[id]) this.bridges[id].checking = false;
    }

    async isConfigurationChanged({ id, type }, configuration) {
        try {
            const bridgeType = await this.retrieveBridgeType(type);

            this.debug.info('BridgesManager.isConfigurationChanged', `Type - ${type}, id - ${id}`);

            const containerName = this.getContainerName(type, id);
            const dir = path.join(PATH_TO_BRIDGE_CONFIGS, containerName);

            const env = envfile.parseFileSync(path.join(dir, '.env'));

            this.debug.info('BridgesManager.isConfigurationChanged', `Parsed env for ${id}`);

            if (!env || !env.MQTT_PASS || !env.MQTT_USER || !env.MQTT_URI) return true;

            this.debug.info('BridgesManager.isConfigurationChanged', `Valid env for ${id}`);

            // eslint-disable-next-line no-shadow
            for (const { name, type } of bridgeType.configuration.fields) {
                switch (type) {
                    case 'javascript':
                        try {
                            this.debug.info('BridgesManager.isConfigurationChanged', 'javascript');

                            const oldCode = fs.readFileSync(path.join(dir, `${name}.js`), 'utf8');
                            const newCode = configuration[name];
                            if (oldCode !== newCode) return true;
                        } catch (err) {
                            this.debug.warning('BridgesManager.isConfigurationChanged.javascript', err);

                            if (err.code === 'ENOENT') return true; // if there is no such file by current path
                            throw err;
                        }
                    // eslint-disable-next-line no-fallthrough
                    case 'modbus-config':
                    case 'json': {
                        try {
                            this.debug.info('BridgesManager.isConfigurationChanged', 'json');

                            if (!_.isEqual(JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')), configuration[name])) return true;
                        } catch (e) {
                            this.debug.warning('BridgesManager.isConfigurationChanged.json', e);

                            if (e.code === 'ENOENT') return true; // if there is no such file by current path
                            throw e;
                        }
                        break;
                    }
                    case 'string':
                    case 'integer':
                    default: {
                        if (`${env[name] || ''}` !== `${configuration[name] || ''}`) return true;
                        break;
                    }
                }
            }

            return false;
        } catch (e) {
            this.debug.warning('BridgesManager.isConfigurationChanged', e);

            return true;
        }
    }

    async saveConfiguration({ id, type }, configuration) {
        const bridgeType = await this.retrieveBridgeType(type);

        this.debug.info('BridgesManager.saveConfiguration', `Bridge found - ${id}`);

        const containerName = this.getContainerName(type, id);
        const dir = path.join(PATH_TO_BRIDGE_CONFIGS, containerName);

        fs.ensureDirSync(dir);
        let old_env = null;
        let env = null;

        try {
            old_env = envfile.parseFileSync(path.join(dir, '.env'));
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }

        let MQTT_USER = null;

        let MQTT_PASS = null;

        if (old_env) {
            MQTT_USER = old_env.MQTT_USER;
            MQTT_PASS = old_env.MQTT_PASS;
        }

        if (!MQTT_USER) MQTT_USER = id;

        if (!MQTT_PASS) {
            this.debug.info('BridgesManager.saveConfigaration', `ACL register - ${MQTT_USER}`);
            MQTT_PASS = await this.core.services.aclManager.register(MQTT_USER, undefined, {
                privilege : bridgeType.configuration.privilege,
                bridgeId  : id
            });
        }
        env = {
            MQTT_USER,
            MQTT_PASS,
            MQTT_URI : (bridgeType.configuration.network_mode === 'host') ? 'mqtt://localhost:1883' : MQTT_URI
        };
        // eslint-disable-next-line no-shadow
        bridgeType.configuration.fields.forEach(({ name, type }) => {
            if (old_env) delete old_env[name];
            if (!configuration[name]) return;

            switch (type) {
                // eslint-disable-next-line no-case-declarations
                case 'javascript':
                    const jsConfigPath = path.join(dir, `${name}.js`);
                    const code = configuration[name];
                    fs.writeFileSync(jsConfigPath, code);
                    break;
                case 'modbus-config':
                // eslint-disable-next-line no-case-declarations,no-fallthrough
                case 'json':
                    const configPath = path.join(dir, `${name}.json`);
                    const configData = JSON.stringify(configuration[name], null, 4);
                    fs.writeFileSync(configPath, configData);
                    break;
                case 'string':
                case 'integer':
                default: {
                    env[name] = configuration[name];
                    break;
                }
            }
        });

        for (const name of _.keys(old_env)) env[name] = old_env[name];

        fs.writeFileSync(path.join(dir, '.env'), envfile.stringifySync(env));
    }

    async removeConfiguration({ id, type }) {
        this.debug.info('BridgesManager.removeConfiguration', `id - ${id}, type - ${type}`);

        const bridge = this.bridges[id];
        const containerName = this.getContainerName(type, id);
        const dir = path.join(PATH_TO_BRIDGE_CONFIGS, containerName);

        if (fs.existsSync(dir)) {
            fs.removeSync(dir);
        }

        if (bridge.sharedVolumes && Array.isArray(bridge.sharedVolumes)) {
            bridge.sharedVolumes.forEach(volume => {
                const sharedDir = path.join(PATH_TO_SHARED_DIR, volume);

                if (fs.existsSync(sharedDir)) fs.emptyDirSync(sharedDir);
            });
        }
    }

    async getRidOfTheContainer(id) {
        const bridge = this.bridges[id];

        // eslint-disable-next-line prefer-const
        let { entity, containerInfo, type } = bridge;

        const containerName = containerInfo && containerInfo.Names && containerInfo.Names.length && containerInfo.Names[0].slice(1) || this.getContainerName(type || entity.getAttribute('type'), id);

        try {
            this.debug.info('BridgesManager.getRidOfTheContainer', `try ${id}`);

            if (bridge.detach) await bridge.detach();

            const { State } = await docker.getContainer(containerName).inspect();

            // 'restarting' counts as live too — Docker is actively managing it,
            // and remove() will 409 unless we stop first (or force-remove).
            if (State.Status === 'running' || State.Status === 'restarting') {
                try {
                    await docker.getContainer(containerName).stop();
                } catch (err) {
                    // Already stopped between inspect and stop — fine, force-remove below.
                    if (err.statusCode !== 304 && err.reason !== 'container not running') throw err;
                }
            }

            // force=true so we also handle anything Docker may have transitioned the
            // container into between stop() and remove() (e.g. 'restarting' again).
            await docker.getContainer(containerName).remove({ force: true });
        } catch (err) {
            if (err.reason !== 'no such container') throw err;
        }

        delete bridge.containerInfo;

        if (!bridge.entity && this.bridges[id]) delete this.bridges[id];
    }

    async validateBridgeConriguration({ type, configuration }) {
        this.debug.info('BridgesManager.validateBridgeConriguration', JSON.stringify({ type, configuration }));

        if (!type) throw new Error('\'type\' field is required.');
        if (!configuration) {
            throw new VALIDATION({
                fields : {
                    configuration : 'required'
                },
                message : 'Validation error!'
            });
        }

        const bridgeType = await this.retrieveBridgeType(type);

        const rules = {};

        bridgeType.configuration.fields.forEach((field) => {
            rules[field.name] = field.validation || [];
        });

        const validator = new LIVR.Validator(rules);
        const validated = validator.validate(configuration);

        if (!validated) {
            throw new VALIDATION({
                fields  : validator.getErrors(),
                message : 'Validation error!'
            });
        }
    }

    async publishError(error, topic) {
        try {
            if (!(error instanceof X)) {
                this.debug.error(error);
                // eslint-disable-next-line no-param-reassign
                error = new UNKNOWN_ERROR();
            }

            this.debug.warning('BridgesManager.publishError', {
                code    : error.code,
                fields  : error.fields,
                message : error.message
            });

            this.core.homie.publishToBroker(`${this.errorTopic}/${topic}`, JSON.stringify(error), { retain: false });
        } catch (e) {
            this.debug.warning('BridgesManager.publishError', e);
        }
    }

    async publishEntityError(error, entity, key) {
        try {
            if (!(error instanceof X)) {
                this.debug.error(error);
                // eslint-disable-next-line no-param-reassign
                error = new UNKNOWN_ERROR();
            }

            this.debug.warning('BridgesManager.publishEntityError', {
                code    : error.code,
                fields  : error.fields,
                message : error.message
            });

            await entity.publishError(key, error);
        } catch (e) {
            this.debug.warning('BridgesManager.publishEntityError', e);
        }
    }

    async _reloadNginxContainer() {
        try {
            const nginxContainer = await docker.getContainer('2smart-nginx');

            await nginxContainer.kill({ signal: 'HUP' });
        } catch (e) {
            this.debug.warning('BridgesManager._reloadNginxContainer', e);
        }
    }

    _subscribeBridgeToStreamEvents(id) {
        this.debug.info('BridgesManager._subscribeBridgeToStreamEvents');
        const bridge = this.bridges[id];
        const { streamEvents } = bridge;

        if (!streamEvents) return;

        Object.keys(streamEvents).forEach(event => {
            const methodName = streamEvents[event];
            const eventName = `${id}.${event}`;

            this.debug.info('BridgesManager._subscribeBridgeToStreamEvents', `event - ${eventName}`);
            this.on(eventName, this.bridgeStreamHandlers[methodName]);
        });
    }

    _unsubscribeBridgeFromStreamEvents(id) {
        this.debug.info('BridgesManager._unsubscribeBridgeFromStreamEvents');
        const bridge = this.bridges[id];
        const { streamEvents } = bridge;

        if (!streamEvents) return;

        Object.keys(streamEvents).forEach(event => {
            const methodName = streamEvents[event];
            const eventName = `${id}.${event}`;

            this.debug.info('BridgesManager._unsubscribeBridgeFromStreamEvents', `event - ${eventName}`);
            this.off(eventName, this.bridgeStreamHandlers[methodName]);
        });
    }
}


module.exports = BridgesManager;
