import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { TuyaBLELockAccessory } from './lockAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { NodeBleTransport } from './tuya/bleTransport.js';
import type { BleTransport } from './tuya/bleTransport.js';
import { TuyaBLEDevice } from './tuya/device.js';
import type { GattOp, OpQueue } from './tuya/device.js';
import type { LockConfig, PlatformConfigShape } from './tuya/types.js';
import { tagLogger } from './util/logger.js';

interface AccessoryContext {
  mac: string;
}

export class TuyaBLEPlatform implements DynamicPlatformPlugin {
  readonly accessoryHandlers = new Map<string, TuyaBLELockAccessory>();
  readonly devices = new Map<string, TuyaBLEDevice>();
  private readonly cachedAccessories: PlatformAccessory<AccessoryContext>[] = [];
  private readonly transport: BleTransport;
  private readonly opQueue: OpQueue;
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.transport = new NodeBleTransport(this.log);
    this.opQueue = this.makeOpQueue();

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((err) => {
        this.log.error(
          `discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    this.api.on('shutdown', () => {
      void this.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory as PlatformAccessory<AccessoryContext>);
  }

  private async discoverDevices(): Promise<void> {
    const cfg = this.config as unknown as PlatformConfigShape;
    const lockConfigs = cfg.locks ?? [];
    if (lockConfigs.length === 0) {
      this.log.warn('no locks configured; nothing to do');
      return;
    }

    try {
      await this.transport.ensureAdapterReady();
    } catch (err) {
      this.log.error(
        `BlueZ adapter unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const seenUuids = new Set<string>();
    for (const lockCfg of lockConfigs) {
      try {
        validateLockConfig(lockCfg);
      } catch (err) {
        this.log.error(
          `invalid lock config (${lockCfg.name ?? 'unnamed'}): ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const uuid = this.api.hap.uuid.generate(lockCfg.mac.toLowerCase());
      seenUuids.add(uuid);
      const cached = this.cachedAccessories.find((a) => a.UUID === uuid);
      const accessory =
        cached ?? new this.api.platformAccessory<AccessoryContext>(lockCfg.name, uuid);
      accessory.context.mac = lockCfg.mac;

      const deviceLog = tagLogger(this.log, lockCfg.mac);
      const device = new TuyaBLEDevice(lockCfg, this.transport, this.opQueue, deviceLog);
      device.on('authFailedStaleKey', () => {
        this.log.error(
          `[${lockCfg.mac}] auth failed — local_key may be stale; re-fetch from cloud.tuya.com`,
        );
      });
      this.devices.set(lockCfg.mac, device);

      const handler = new TuyaBLELockAccessory(this, accessory, lockCfg, device);
      this.accessoryHandlers.set(lockCfg.mac, handler);

      if (!cached) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`registered new lock accessory: ${lockCfg.name} (${lockCfg.mac})`);
      } else {
        accessory.displayName = lockCfg.name;
        this.api.updatePlatformAccessories([accessory]);
        this.log.info(`restored lock accessory from cache: ${lockCfg.name} (${lockCfg.mac})`);
      }
    }

    const stale = this.cachedAccessories.filter((a) => !seenUuids.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`removed ${stale.length} stale accessory(ies)`);
    }
  }

  private makeOpQueue(): OpQueue {
    return <T>(op: GattOp<T>): Promise<T> => {
      const next = this.opChain.then(op, op);
      this.opChain = next.catch(() => undefined);
      return next;
    };
  }

  private async shutdown(): Promise<void> {
    this.log.info('shutting down');
    await Promise.allSettled(
      Array.from(this.devices.values()).map((d) => d.shutdown()),
    );
    await this.transport.shutdown();
  }
}

function validateLockConfig(cfg: LockConfig | undefined): asserts cfg is LockConfig {
  if (!cfg) throw new Error('missing config');
  for (const f of ['name', 'mac', 'uuid', 'device_id', 'local_key'] as const) {
    if (typeof cfg[f] !== 'string' || cfg[f].length === 0) {
      throw new Error(`missing required field "${f}"`);
    }
  }
  if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(cfg.mac)) {
    throw new Error(`invalid mac: ${cfg.mac}`);
  }
  if (cfg.local_key.length < 6) {
    throw new Error('local_key must be at least 6 characters');
  }
}
