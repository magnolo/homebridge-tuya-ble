import { EventEmitter } from 'node:events';

import { GATT_MTU } from '../settings.js';
import type { LeafLogger } from '../util/logger.js';
import type { BleTransport, PeripheralLink } from './bleTransport.js';
import { AuthState, CommandCode, DpType, SecurityFlag } from './codes.js';
import {
  BleReassembler,
  buildPairPayload,
  decodeDps,
  decodePacket,
  deriveLoginKey,
  deriveSessionKey,
  encodeDps,
  encodePacket,
  fragmentForBle,
  parseDeviceInfoResponse,
} from './protocol.js';
import type { KeyBag } from './protocol.js';
import type { Datapoint, DpValue, LockConfig, ParsedPacket } from './types.js';

const HANDSHAKE_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 7_000;
const WATCHDOG_TIMEOUT_MS = 20_000;
const DEFAULT_IDLE_DISCONNECT_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 30_000;
const BACKOFF_SCHEDULE_MS = [1_000, 2_000, 5_000, 15_000, 60_000];

export type GattOp<T> = () => Promise<T>;
export type OpQueue = <T>(op: GattOp<T>) => Promise<T>;

interface PendingWaiter {
  match: (code: CommandCode) => boolean;
  resolve: (packet: ParsedPacket) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class TuyaBLEDevice extends EventEmitter {
  private state: AuthState = AuthState.DISCONNECTED;
  private link: PeripheralLink | null = null;
  private reassembler = new BleReassembler();
  private keys: KeyBag;
  private seqNum = 1;
  private writePacketNum = 1;
  private pendingWaiter: PendingWaiter | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;
  private backoffIndex = 0;
  private shuttingDown = false;

  constructor(
    private readonly config: LockConfig,
    private readonly transport: BleTransport,
    private readonly opQueue: OpQueue,
    private readonly log: LeafLogger,
  ) {
    super();
    this.keys = { loginKey: deriveLoginKey(config.local_key) };
  }

  getState(): AuthState {
    return this.state;
  }

  async ensureReady(): Promise<void> {
    if (this.state === AuthState.READY) {
      this.bumpIdle();
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.runConnect().finally(() => {
        this.connectPromise = null;
      });
    }
    await this.connectPromise;
  }

  async sendDps(dps: Datapoint[]): Promise<void> {
    await this.ensureReady();
    const payload = encodeDps(dps);
    await this.opQueue(() => this.sendPacket(CommandCode.SENDER_DPS, payload, SecurityFlag.SESSION));
    this.bumpIdle();
  }

  sendDp(id: number, type: DpType, value: DpValue): Promise<void> {
    return this.sendDps([{ id, type, value }]);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearIdle();
    this.clearWatchdog();
    await this.disconnect('shutdown');
  }

  private async runConnect(): Promise<void> {
    let attempt = 0;
    while (!this.shuttingDown) {
      try {
        await this.opQueue(() => this.doConnectAndAuth());
        this.backoffIndex = 0;
        return;
      } catch (err) {
        await this.disconnect(`connect failed: ${describe(err)}`);
        if (this.shuttingDown) throw err;
        attempt++;
        const delay = nextBackoff(this.backoffIndex);
        this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_SCHEDULE_MS.length - 1);
        this.log.warn(`connect attempt ${attempt} failed (${describe(err)}); retry in ${Math.round(delay)}ms`);
        await sleep(delay);
      }
    }
    throw new Error('shutting down');
  }

  private async doConnectAndAuth(): Promise<void> {
    this.setState(AuthState.CONNECTING);
    this.startWatchdog();
    this.link = await this.transport.connectPeripheral(this.config.mac, DISCOVERY_TIMEOUT_MS);
    this.link.notify.on('valuechanged', this.onNotify);
    this.link.onDisconnect(this.onRemoteDisconnect);

    this.seqNum = 1;
    this.writePacketNum = 1;
    this.reassembler.reset();
    this.keys = { loginKey: deriveLoginKey(this.config.local_key) };

    this.setState(AuthState.AUTH_DEVICE_INFO);
    await this.sendPacket(CommandCode.SENDER_DEVICE_INFO, Buffer.alloc(0), SecurityFlag.LOGIN);
    const deviceInfo = await this.waitForAny([CommandCode.SENDER_DEVICE_INFO], HANDSHAKE_TIMEOUT_MS);
    const parsedInfo = parseDeviceInfoResponse(deviceInfo.data);
    this.keys.sessionKey = deriveSessionKey(this.config.local_key, parsedInfo.srand);
    this.keys.authKey = parsedInfo.authKey;

    this.setState(AuthState.AUTH_PAIR);
    const pairPayload = buildPairPayload(this.config.uuid, this.config.local_key, this.config.device_id);
    await this.sendPacket(CommandCode.SENDER_PAIR, pairPayload, SecurityFlag.LOGIN);
    const pairAck = await this.waitForAny([CommandCode.SENDER_PAIR], HANDSHAKE_TIMEOUT_MS);
    if (pairAck.data.length > 0 && pairAck.data[0] !== 0 && pairAck.data[0] !== 2) {
      this.emit('authFailedStaleKey');
      throw new Error(
        `pair rejected (result=${pairAck.data[0]}); local_key may be stale — re-fetch from cloud.tuya.com`,
      );
    }

    this.setState(AuthState.AUTH_STATUS);
    await this.sendPacket(CommandCode.SENDER_DEVICE_STATUS, Buffer.alloc(0), SecurityFlag.SESSION);
    await this.waitForAny(
      [CommandCode.RECEIVE_DP, CommandCode.SENDER_DEVICE_STATUS],
      STATUS_TIMEOUT_MS,
    ).catch((err) => {
      this.log.warn(`device_status no echo (${describe(err)}); continuing`);
    });

    this.setState(AuthState.READY);
    this.clearWatchdog();
    this.bumpIdle();
  }

  private setState(state: AuthState): void {
    if (this.state === state) return;
    this.state = state;
    this.log.debug(`state -> ${state}`);
    this.emit('state', state);
  }

  private startWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.log.warn(`watchdog: stuck in ${this.state} > ${WATCHDOG_TIMEOUT_MS}ms; forcing disconnect`);
      void this.disconnect('watchdog');
    }, WATCHDOG_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private bumpIdle(): void {
    this.clearIdle();
    if (this.state !== AuthState.READY) return;
    const ms = this.config.idleDisconnectMs ?? DEFAULT_IDLE_DISCONNECT_MS;
    if (ms <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.log.debug('idle timeout; disconnecting');
      void this.disconnect('idle');
    }, ms);
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private onNotify = (chunk: Buffer): void => {
    try {
      const full = this.reassembler.feed(chunk);
      if (!full) return;
      const packet = decodePacket(full, this.keys);
      if (this.config.dpsLogLevel === 'debug') {
        this.log.debug(`recv code=0x${packet.code.toString(16)} data=${packet.data.toString('hex')}`);
      }
      this.handlePacket(packet);
    } catch (err) {
      this.log.warn(`notify decode failed: ${describe(err)}`);
    }
  };

  private handlePacket(packet: ParsedPacket): void {
    if (this.pendingWaiter?.match(packet.code)) {
      const waiter = this.pendingWaiter;
      this.pendingWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(packet);
    }

    if (
      packet.code === CommandCode.RECEIVE_DP ||
      packet.code === CommandCode.RECEIVE_TIME_DP ||
      packet.code === CommandCode.RECEIVE_SIGN_DP ||
      packet.code === CommandCode.RECEIVE_SIGN_TIME_DP
    ) {
      const dpData = stripDpHeader(packet.code, packet.data);
      const dps = decodeDps(dpData);
      for (const dp of dps) {
        if (this.config.dpsLogLevel === 'info' || this.config.dpsLogLevel === 'debug') {
          this.log.info(`dp id=${dp.id} type=${dp.type} value=${formatDpValue(dp.value)}`);
        }
        this.emit('dp', dp);
      }
      this.bumpIdle();
    }
  }

  private onRemoteDisconnect = (): void => {
    this.log.debug('remote disconnect');
    void this.disconnect('remote');
  };

  private async disconnect(reason: string): Promise<void> {
    this.clearIdle();
    this.clearWatchdog();
    if (this.pendingWaiter) {
      const waiter = this.pendingWaiter;
      this.pendingWaiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`disconnected: ${reason}`));
    }
    const link = this.link;
    this.link = null;
    if (link) {
      try {
        link.notify.removeListener('valuechanged', this.onNotify);
        await link.notify.stopNotifications().catch(() => undefined);
        if (await link.device.isConnected().catch(() => false)) {
          await link.device.disconnect().catch(() => undefined);
        }
      } catch (err) {
        this.log.debug(`disconnect cleanup: ${describe(err)}`);
      }
    }
    this.keys = { loginKey: this.keys.loginKey };
    this.seqNum = 1;
    this.writePacketNum = 1;
    this.reassembler.reset();
    this.setState(AuthState.DISCONNECTED);
  }

  private async sendPacket(code: CommandCode, data: Buffer, flag: SecurityFlag): Promise<void> {
    if (!this.link) throw new Error('not connected');
    const packet = encodePacket({
      seqNum: this.seqNum++,
      responseTo: 0,
      code,
      data,
      securityFlag: flag,
      keys: this.keys,
    });
    const chunks = fragmentForBle(packet, this.writePacketNum, GATT_MTU);
    this.writePacketNum += chunks.length;
    for (const chunk of chunks) {
      await this.link.write.writeValue(chunk, { type: 'request' });
    }
  }

  private waitForAny(codes: CommandCode[], timeoutMs: number): Promise<ParsedPacket> {
    if (this.pendingWaiter) {
      return Promise.reject(new Error('already awaiting an inbound packet'));
    }
    return new Promise<ParsedPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWaiter = null;
        reject(
          new Error(
            `timeout waiting for code ${codes.map((c) => `0x${c.toString(16)}`).join('|')}`,
          ),
        );
      }, timeoutMs);
      this.pendingWaiter = {
        match: (code) => codes.includes(code),
        resolve,
        reject,
        timer,
      };
    });
  }
}

function nextBackoff(idx: number): number {
  const base = BACKOFF_SCHEDULE_MS[Math.min(idx, BACKOFF_SCHEDULE_MS.length - 1)];
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripDpHeader(code: CommandCode, data: Buffer): Buffer {
  switch (code) {
    case CommandCode.RECEIVE_DP:
      return data;
    case CommandCode.RECEIVE_TIME_DP:
      return data.length > 6 ? data.subarray(6) : data;
    case CommandCode.RECEIVE_SIGN_DP:
      return data.length > 1 ? data.subarray(1) : data;
    case CommandCode.RECEIVE_SIGN_TIME_DP:
      return data.length > 7 ? data.subarray(7) : data;
    default:
      return data;
  }
}

function formatDpValue(v: DpValue): string {
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
  return String(v);
}
