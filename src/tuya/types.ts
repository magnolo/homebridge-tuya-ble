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
