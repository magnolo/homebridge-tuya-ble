import { EventEmitter } from 'node:events';

import { TUYA_GATT_PROFILES } from '../settings.js';
import type { LeafLogger } from '../util/logger.js';

interface NodeBleAdapter {
  isDiscovering(): Promise<boolean>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  waitDevice(mac: string, timeout?: number): Promise<NodeBleDevice>;
  getDevice(mac: string): Promise<NodeBleDevice>;
}

interface NodeBleDevice extends EventEmitter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  gatt(): Promise<NodeBleGatt>;
}

interface NodeBleGatt {
  getPrimaryService(uuid: string): Promise<NodeBleService>;
}

interface NodeBleService {
  getCharacteristic(uuid: string): Promise<NodeBleCharacteristic>;
}

interface NodeBleCharacteristic extends EventEmitter {
  startNotifications(): Promise<void>;
  stopNotifications(): Promise<void>;
  writeValue(buf: Buffer, options?: { type?: 'command' | 'request' | 'reliable' }): Promise<void>;
}

export interface PeripheralLink {
  notify: NodeBleCharacteristic;
  write: NodeBleCharacteristic;
  device: NodeBleDevice;
  onDisconnect: (handler: () => void) => void;
}

export interface BleTransport {
  ensureAdapterReady(): Promise<void>;
  startDiscovery(): Promise<void>;
  releaseDiscovery(): Promise<void>;
  connectPeripheral(mac: string, discoveryTimeoutMs: number): Promise<PeripheralLink>;
  shutdown(): Promise<void>;
}

interface NodeBleHandle {
  bluetooth: {
    defaultAdapter(): Promise<NodeBleAdapter>;
  };
  destroy(): void;
}

interface NodeBleModule {
  createBluetooth(): NodeBleHandle;
}

export class NodeBleTransport implements BleTransport {
  private handle: NodeBleHandle | null = null;
  private adapter: NodeBleAdapter | null = null;
  private discoveryRefCount = 0;

  constructor(private readonly log: LeafLogger) {}

  async ensureAdapterReady(): Promise<void> {
    if (this.adapter) return;
    if (!this.handle) {
      const mod = (await import('node-ble')) as unknown as NodeBleModule;
      this.handle = mod.createBluetooth();
    }
    const start = Date.now();
    let lastErr: unknown;
    while (Date.now() - start < 30_000) {
      try {
        this.adapter = await this.handle.bluetooth.defaultAdapter();
        this.log.info('BlueZ adapter acquired');
        return;
      } catch (err) {
        lastErr = err;
        await sleep(2_000);
      }
    }
    throw new Error(`failed to acquire BlueZ adapter within 30s: ${describeError(lastErr)}`);
  }

  async startDiscovery(): Promise<void> {
    await this.ensureAdapterReady();
    if (!this.adapter) throw new Error('adapter not ready');
    this.discoveryRefCount++;
    if (this.discoveryRefCount === 1) {
      const already = await this.adapter.isDiscovering();
      if (!already) {
        await this.adapter.startDiscovery();
        this.log.debug('discovery started');
      }
    }
  }

  async releaseDiscovery(): Promise<void> {
    if (this.discoveryRefCount === 0) return;
    this.discoveryRefCount--;
    if (this.discoveryRefCount === 0 && this.adapter) {
      const active = await this.adapter.isDiscovering();
      if (active) {
        try {
          await this.adapter.stopDiscovery();
          this.log.debug('discovery stopped');
        } catch (err) {
          this.log.warn(`stopDiscovery failed: ${describeError(err)}`);
        }
      }
    }
  }

  async connectPeripheral(mac: string, discoveryTimeoutMs: number): Promise<PeripheralLink> {
    await this.ensureAdapterReady();
    if (!this.adapter) throw new Error('adapter not ready');

    await this.startDiscovery();
    try {
      const device = await this.adapter.waitDevice(mac.toUpperCase(), discoveryTimeoutMs);
      await this.connectWithRetries(device);
      const gatt = await device.gatt();

      // Tuya BLE devices ship in two GATT layouts (FD50/vendor and A201/2B10/2B11).
      // Try each profile until one resolves a usable notify+write pair.
      let lastErr: unknown;
      for (const profile of TUYA_GATT_PROFILES) {
        try {
          const service = await gatt.getPrimaryService(profile.service);
          const notify = await service.getCharacteristic(profile.notify);
          const write = await service.getCharacteristic(profile.write);
          await notify.startNotifications();
          this.log.info(
            `using GATT profile ${profile.service} (notify=${profile.notify}, write=${profile.write}); notifications enabled`,
          );
          return {
            device,
            notify,
            write,
            onDisconnect: (handler) => {
              device.once('disconnect', () => handler());
            },
          };
        } catch (err) {
          lastErr = err;
        }
      }
      throw new Error(
        `no Tuya GATT service matched on this device: ${describeError(lastErr)}`,
      );
    } finally {
      // Stop discovery only after the connection has succeeded (or failed) — Tuya BLE locks
      // re-enter a non-connectable state quickly, and stopping discovery early causes BlueZ
      // to abort the connect with "Resource Not Ready".
      await this.releaseDiscovery();
    }
  }

  private async connectWithRetries(device: NodeBleDevice): Promise<void> {
    const deadline = Date.now() + 12_000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        await device.connect();
        return;
      } catch (err) {
        lastErr = err;
        const msg = describeError(err);
        if (!isTransientConnectError(msg)) throw err;
        this.log.debug(`connect transient (${msg}); retrying`);
        await sleep(750);
      }
    }
    throw new Error(`connect timed out after retries: ${describeError(lastErr)}`);
  }

  async shutdown(): Promise<void> {
    try {
      if (this.adapter && this.discoveryRefCount > 0) {
        const active = await this.adapter.isDiscovering();
        if (active) await this.adapter.stopDiscovery();
      }
    } catch (err) {
      this.log.warn(`shutdown stopDiscovery: ${describeError(err)}`);
    }
    this.discoveryRefCount = 0;
    if (this.handle) {
      this.handle.destroy();
      this.handle = null;
      this.adapter = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isTransientConnectError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('not ready') ||
    lower.includes('in progress') ||
    lower.includes('le-connection-abort-by-local') ||
    lower.includes('software caused connection abort') ||
    lower.includes('host is down')
  );
}
