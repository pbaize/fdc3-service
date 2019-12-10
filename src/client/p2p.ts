import { Fin, Identity } from "openfin/_v2/main";

import { IntentResolution, AppIntent, IntentListener } from "./main";

import { ChannelClient } from "openfin/_v2/api/interappbus/channel/client";

import { ChannelProvider } from "openfin/_v2/api/interappbus/channel/provider";
import { ProviderIdentity } from "openfin/_v2/api/interappbus/channel/channel";

/**
 * A (partial) Peer to peer implementation of FDC3.
 * Introduces the FDC3.Agent api which is required to be implemented for more complex fdc3 functionality.
 * No re-connect logic
 * conflicts when joining multiple channels
 * difference between broadcast on a fdc3 client and the "global" broadcast
 */

declare var fin: Fin;
// tslint:disable no-any
const connectionsToAgents = new Map<string, FDC3Client>();
const agents = new Map<string, FDC3Agent>();
// tslint:disable-next-line: ban-ts-ignore
//@ts-ignore
const me: Identity = fin.wire.me;
let globalIntentListeners: Array<[string, (c: any) => void]> = [];
const ready = init();
// tslint:disable-next-line: ban-ts-ignore
//@ts-ignore
export const fdc3 = {
    connections: connectionsToAgents,
    agents,
    ready,
    Agent: {
        create: async (name: string) => {
            const channel = 'FDC3P2P' + name;
            if (agents.has(name)) {
                return <FDC3Agent>agents.get(name);
            }
            await fin.InterApplicationBus.subscribe(
                { uuid: '*' },
                'FDC3P2P/get-all-agents',
                (_: any, source: Identity) => {
                    console.log('agent-request-received')
                    fin.InterApplicationBus.send(source, 'FDC3P2P/add-agent', {
                        channel,
                        name,
                    }).then(() => console.log(source)).catch(console.error)
                }
            );
            const provider = await fin.InterApplicationBus.Channel.create(channel);
            const agent = new FDC3Agent(name, provider);
            agents.set(name, agent);
            setTimeout(
                () =>
                    fin.InterApplicationBus.publish('FDC3P2P/add-agent', {
                        channel,
                        name,
                    }),
                100
            ); // give time to add connection listener
            return agent;
        },
        connect: async (name: string, payload?: any) => {
            if (connectionsToAgents.has(name)) {
                return connectionsToAgents.get(name);
            }
            const client = await fin.InterApplicationBus.Channel.connect(
                'FDC3P2P' + name,
                payload
            );
            return new FDC3Client(name, client);
        },
    },
    async raiseIntent(
        intent: string,
        context: object,
        target?: string | undefined
    ): Promise<IntentResolution> {
        await ready;
        if (connectionsToAgents.size === 0) {
            throw new Error('No Agent Running');
        }
        return new Promise((resolve, reject) => {
            let pending: Array<Promise<void>> = [];
            for (const client of connectionsToAgents.values()) {
                const p = client
                    .raiseIntent(intent, context, target)
                    .then(v => {
                        resolve(v);
                    })
                    .catch(e => {
                        pending = pending.filter(x => x !== p);
                        if (pending.length === 0) {
                            reject(e);
                        }
                    });
                pending.push(p);
            }
        });
    },
    async addIntentListener(intent: string, handler: (context: any) => void) {
        await ready;
        const tuple: [string, (c: any) => void] = [intent, handler];
        globalIntentListeners.push(tuple);
        const unsubscribes: Array<() => Promise<void>> = [];
        for (const client of connectionsToAgents.values()) {
            const { unsubscribe } = await client.addIntentListener(intent, handler);
            unsubscribes.push(unsubscribe);
        }
        const unsubscribe = async () => {
            globalIntentListeners = globalIntentListeners.filter(x => x !== tuple);
            await Promise.all(unsubscribes.map(x => x()));
        };
        return { unsubscribe, intent, handler };
    },
};

async function init() {
    // tslint:disable-next-line: ban-ts-ignore
    //@ts-ignore
    await new Promise(r => window.addEventListener('DOMContentLoaded', r))
    if (!fin.me) {
        // tslint:disable-next-line: ban-ts-ignore
        //@ts-ignore
        fin.me = fin.wire.me
    }
    await fin.InterApplicationBus.subscribe(
        { uuid: '*' },
        'FDC3P2P/add-agent',
        async (info: any, source: Identity) => {
            if (!agents.has(info.name) && !(source.name === fin.me.name && source.uuid === fin.me.uuid)) {
                console.log(info, source)
                const channel = await fin.InterApplicationBus.Channel.connect(
                    info.channel
                );
                const client = new FDC3Client(info.name, channel);
                connectionsToAgents.set(info.name, client);
                globalIntentListeners.forEach(([i, f]) =>
                    client.addIntentListener(i, f)
                );
            }
        }
    );
    await fin.InterApplicationBus.publish('FDC3P2P/get-all-agents', me);
}
class FDC3Client {
    private intentListeners: Map<string, (context: object) => void>;
    constructor(public name: string, private client: ChannelClient) {
        this.intentListeners = new Map();
        client.setDefaultAction(() => {
            throw new Error('FDC3 Client does not support this method');
        })
        client.register('intent-raised', ({ intent, context }: any) => {
            if (this.intentListeners.has(intent)) {
                // tslint:disable-next-line: ban-ts-ignore
                //@ts-ignore
                return this.intentListeners.get(intent)(context)
            } else {
                throw new Error("no intent registered");
            }
        })
    }

    findIntent = (
        intent: string,
        context?: object | undefined
    ): Promise<AppIntent> => {
        throw new Error('Method not implemented.');
    };
    findIntentsByContext = (context: object): Promise<AppIntent[]> => {
        throw new Error('Method not implemented.');
    };
    raiseIntent = (
        intent: string,
        context: object,
        target?: string | undefined
    ): Promise<IntentResolution> => {
        return this.client.dispatch('raise-intent', { intent, context, target });
    };
    addIntentListener = async (
        intent: string,
        handler: (context: object) => void
    ) => {
        if (this.intentListeners.has(intent)) {
            throw new Error('Listener already registered for intent');
        } else {
            this.intentListeners.set(intent, handler);
            await this.client.dispatch('intent-listener-added', { intent });
            return {
                intent, handler,
                unsubscribe: async () => {
                    this.intentListeners.delete(intent);
                    await this.client.dispatch('intent-listener-removed', { intent });
                },
            };
        }
    };
    open = async (name: string, context?: any) => {
        await this.client.dispatch('open', { name, context });
    };
}

export class FDC3Agent {
    channels = new Map<string, any>();
    private intentListenerAddedListeners: Array<(intent: any, identity: ProviderIdentity) => void> = [];
    private intentListenerRemovedListeners: Array<(intent: any, identity: ProviderIdentity) => void> = [];
    constructor(public name: string, public provider: ChannelProvider) {
        provider.setDefaultAction(() => {
            throw new Error('FDC3 Agent has not implemented this method');
        });
        provider.register('intent-listener-added', ({ intent }, identity) => {
            this.intentListenerAddedListeners.forEach(element => {
                element(intent, identity)
            });
        })
        provider.register('intent-listener-removed', ({ intent }, identity) => {
            this.intentListenerRemovedListeners.forEach(element => {
                element(intent, identity)
            });
        })
    }
    sendIntentToClient(to: Identity, intent: string, context: any) {
        return this.provider.dispatch(to, 'intent-raised', { intent, context })
    }
    registerOpenHandler = async (
        handler: (name: string, context: any) => void
    ) => {
        this.provider.register(
            'open',
            ({ context, name }: { name: string; context: any }) =>
                handler(name, context)
        );
    };
    onIntentListenerAdded(listener: (intent: string, identity: ProviderIdentity) => void) {
        this.intentListenerAddedListeners.push(listener)
    }
    onIntentListenerRemoved(listener: (intent: string, identity: ProviderIdentity) => void) {
        this.intentListenerAddedListeners.push(listener)
    }
    registerIntentResolver = async (
        handler: (
            intent: string,
            context: any,
            target?: string,
            identity?: Identity
        ) => Promise<IntentResolution>
    ) => {
        await this.provider.register(
            'raise-intent',
            ({ intent, context, target }: any, sender) =>
                handler(intent, context, target, sender)
        );
    };
}
