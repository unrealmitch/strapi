import { WebSocket } from 'ws';
import { v4 } from 'uuid';
import { Writable } from 'stream';
import { once } from 'lodash/fp';

import { createDispatcher } from './utils';

import type { IDestinationProvider, IMetadata, ProviderType, IAsset } from '../../../../types';
import type { client, server } from '../../../../types/remote/protocol';
import type { ILocalStrapiDestinationProviderOptions } from '../local-destination';
import { TRANSFER_PATH } from '../../remote/constants';
import { ProviderTransferError, ProviderValidationError } from '../../../errors/providers';

interface ITransferTokenAuth {
  type: 'token';
  token: string;
}

export interface IRemoteStrapiDestinationProviderOptions
  extends Pick<ILocalStrapiDestinationProviderOptions, 'restore' | 'strategy'> {
  url: URL;
  auth?: ITransferTokenAuth;
}

const jsonLength = (obj: object) => Buffer.byteLength(JSON.stringify(obj));

class RemoteStrapiDestinationProvider implements IDestinationProvider {
  name = 'destination::remote-strapi';

  type: ProviderType = 'destination';

  options: IRemoteStrapiDestinationProviderOptions;

  ws: WebSocket | null;

  dispatcher: ReturnType<typeof createDispatcher> | null;

  transferID: string | null;

  constructor(options: IRemoteStrapiDestinationProviderOptions) {
    this.options = options;
    this.ws = null;
    this.dispatcher = null;
    this.transferID = null;
  }

  async initTransfer(): Promise<string> {
    const { strategy, restore } = this.options;

    // Wait for the connection to be made to the server, then init the transfer
    return new Promise<string>((resolve, reject) => {
      this.ws
        ?.once('open', async () => {
          try {
            const query = this.dispatcher?.dispatchCommand({
              command: 'init',
              params: { options: { strategy, restore }, transfer: 'push' },
            });

            const res = (await query) as server.Payload<server.InitMessage>;

            if (!res?.transferID) {
              throw new ProviderTransferError('Init failed, invalid response from the server');
            }

            resolve(res.transferID);
          } catch (e: unknown) {
            reject(e);
          }
        })
        .once('error', (message) => {
          reject(message);
        });
    });
  }

  #startStepOnce(stage: client.TransferPushStep) {
    return once(() => this.#startStep(stage));
  }

  async #startStep<T extends client.TransferPushStep>(step: T) {
    try {
      await this.dispatcher?.dispatchTransferStep({ action: 'start', step });
    } catch (e) {
      if (e instanceof Error) {
        return e;
      }

      if (typeof e === 'string') {
        return new ProviderTransferError(e);
      }

      return new ProviderTransferError('Unexpected error');
    }

    return null;
  }

  async #endStep<T extends client.TransferPushStep>(step: T) {
    try {
      await this.dispatcher?.dispatchTransferStep({ action: 'end', step });
    } catch (e) {
      if (e instanceof Error) {
        return e;
      }

      if (typeof e === 'string') {
        return new ProviderTransferError(e);
      }

      return new ProviderTransferError('Unexpected error');
    }

    return null;
  }

  async #streamStep<T extends client.TransferPushStep>(
    step: T,
    data: client.GetTransferPushStreamData<T>
  ) {
    try {
      await this.dispatcher?.dispatchTransferStep({ action: 'stream', step, data });
    } catch (e) {
      if (e instanceof Error) {
        return e;
      }

      if (typeof e === 'string') {
        return new ProviderTransferError(e);
      }

      return new ProviderTransferError('Unexpected error');
    }

    return null;
  }

  #writeStream(step: Exclude<client.TransferPushStep, 'assets'>): Writable {
    type Step = typeof step;

    const batchSize = 1024 * 1024; // 1MB;
    const startTransferOnce = this.#startStepOnce(step);

    let batch = [] as client.GetTransferPushStreamData<Step>;

    const batchLength = () => jsonLength(batch);

    return new Writable({
      objectMode: true,

      final: async (callback) => {
        if (batch.length > 0) {
          const streamError = await this.#streamStep(step, batch);

          batch = [];

          if (streamError) {
            return callback(streamError);
          }
        }
        const e = await this.#endStep(step);

        callback(e);
      },

      write: async (chunk, _encoding, callback) => {
        const startError = await startTransferOnce();
        if (startError) {
          return callback(startError);
        }

        batch.push(chunk);

        if (batchLength() >= batchSize) {
          const streamError = await this.#streamStep(step, batch);

          batch = [];

          if (streamError) {
            return callback(streamError);
          }
        }

        callback();
      },
    });
  }

  async bootstrap(): Promise<void> {
    const { url, auth } = this.options;
    const validProtocols = ['https:', 'http:'];

    let ws: WebSocket;

    if (!validProtocols.includes(url.protocol)) {
      throw new ProviderValidationError(`Invalid protocol "${url.protocol}"`, {
        check: 'url',
        details: {
          protocol: url.protocol,
          validProtocols,
        },
      });
    }
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${url.host}${url.pathname}${TRANSFER_PATH}`;
    // No auth defined, trying public access for transfer
    if (!auth) {
      ws = new WebSocket(wsUrl);
    }

    // Common token auth, this should be the main auth method
    else if (auth.type === 'token') {
      const headers = { Authorization: `Bearer ${auth.token}` };
      ws = new WebSocket(wsUrl, { headers });
    }

    // Invalid auth method provided
    else {
      throw new ProviderValidationError('Auth method not available', {
        check: 'auth.type',
        details: {
          auth: auth.type,
        },
      });
    }

    this.ws = ws;
    this.dispatcher = createDispatcher(this.ws);

    this.transferID = await this.initTransfer();

    this.dispatcher.setTransferProperties({ id: this.transferID, kind: 'push' });

    await this.dispatcher.dispatchTransferAction('bootstrap');
  }

  async close() {
    // Gracefully close the remote transfer process
    if (this.transferID && this.dispatcher) {
      await this.dispatcher.dispatchTransferAction('close');

      await this.dispatcher.dispatchCommand({
        command: 'end',
        params: { transferID: this.transferID },
      });
    }

    await new Promise<void>((resolve) => {
      const { ws } = this;

      if (!ws || ws.CLOSED) {
        resolve();
        return;
      }

      ws.on('close', () => resolve()).close();
    });
  }

  getMetadata() {
    return this.dispatcher?.dispatchTransferAction<IMetadata>('getMetadata') ?? null;
  }

  async beforeTransfer() {
    await this.dispatcher?.dispatchTransferAction('beforeTransfer');
  }

  async rollback() {
    await this.dispatcher?.dispatchTransferAction('rollback');
  }

  getSchemas(): Promise<Strapi.Schemas | null> {
    if (!this.dispatcher) {
      return Promise.resolve(null);
    }

    return this.dispatcher.dispatchTransferAction<Strapi.Schemas>('getSchemas');
  }

  createEntitiesWriteStream(): Writable {
    return this.#writeStream('entities');
  }

  createLinksWriteStream(): Writable {
    return this.#writeStream('links');
  }

  createConfigurationWriteStream(): Writable {
    return this.#writeStream('configuration');
  }

  createAssetsWriteStream(): Writable | Promise<Writable> {
    let batch: client.TransferAssetFlow[] = [];
    let hasStarted = false;

    const batchSize = 1024 * 1024; // 1MB;
    const batchLength = () => {
      return batch.reduce(
        (acc, chunk) => (chunk.action === 'stream' ? acc + chunk.data.byteLength : acc),
        0
      );
    };
    const startAssetsTransferOnce = this.#startStepOnce('assets');

    const flush = async () => {
      await this.#streamStep('assets', batch);
      batch = [];
    };

    const safePush = async (chunk: client.TransferAssetFlow) => {
      batch.push(chunk);

      if (batchLength() >= batchSize) {
        await flush();
      }
    };

    return new Writable({
      objectMode: true,
      final: async (callback) => {
        if (batch.length > 0) {
          await flush();
        }

        if (hasStarted) {
          await this.#streamStep('assets', null);

          const endStepError = await this.#endStep('assets');

          if (endStepError) {
            return callback(endStepError);
          }
        }

        return callback(null);
      },

      async write(asset: IAsset, _encoding, callback) {
        const startError = await startAssetsTransferOnce();

        if (startError) {
          return callback(startError);
        }

        hasStarted = true;

        const assetID = v4();
        const { filename, filepath, stats, stream } = asset;

        await safePush({ action: 'start', assetID, data: { filename, filepath, stats } });

        for await (const chunk of stream) {
          await safePush({ action: 'stream', assetID, data: chunk });
        }

        await safePush({ action: 'end', assetID });

        callback();
      },
    });
  }
}

export const createRemoteStrapiDestinationProvider = (
  options: IRemoteStrapiDestinationProviderOptions
) => {
  return new RemoteStrapiDestinationProvider(options);
};
