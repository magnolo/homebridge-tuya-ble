import { CommandCode, DpType } from './codes.js';

export interface LockConfig {
  name: string;
  mac: string;
  uuid: string;
  device_id: string;
  local_key: string;
  product_id?: string;
  lockDpId?: number;
  lockInverted?: boolean;
  batteryLevelDpId?: number;
  batteryStateDpId?: number;
  idleDisconnectMs?: number;
  dpsLogLevel?: 'off' | 'info' | 'debug';
  protocolVersion?: number;
  /**
   * If true, the plugin publishes the HomeKit accessory but never attempts to
   * connect to the lock over BLE. Useful for FD50/SDK-2.x locks (e.g. 8052Y)
   * whose auth protocol isn't publicly documented — pair this with the
   * homebridge-tuya cloud plugin's deviceOverrides for status visibility.
   */
  monitorOnly?: boolean;
}

export interface PlatformConfigShape {
  name?: string;
  locks?: LockConfig[];
}

export type DpValue = boolean | number | string | Buffer;

export interface Datapoint {
  id: number;
  type: DpType;
  value: DpValue;
}

export interface ParsedPacket {
  seqNum: number;
  responseTo: number;
  code: CommandCode;
  data: Buffer;
  securityFlag: number;
}

export interface DeviceInfoResponse {
  protocolVersion: number;
  srand: Buffer;
  authKey: Buffer;
}
