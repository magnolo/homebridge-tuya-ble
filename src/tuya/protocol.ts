import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { PROTOCOL_VERSION } from '../settings.js';
import { CommandCode, DpType, SecurityFlag } from './codes.js';
import { crc16Modbus } from './crc.js';
import { Datapoint, DpValue, ParsedPacket } from './types.js';

const AES_BLOCK = 16;

export interface KeyBag {
  loginKey: Buffer;
  sessionKey?: Buffer;
  authKey?: Buffer;
}

export function deriveLoginKey(localKey: string): Buffer {
  return md5(Buffer.from(localKey.slice(0, 6), 'utf8'));
}

export function deriveSessionKey(localKey: string, srand: Buffer): Buffer {
  return md5(Buffer.from(localKey.slice(0, 6), 'utf8'), srand);
}

export function selectKey(flag: SecurityFlag, keys: KeyBag): Buffer {
  switch (flag) {
    case SecurityFlag.AUTH:
      if (!keys.authKey) {
        throw new Error('auth_key not yet known');
      }
      return keys.authKey;
    case SecurityFlag.LOGIN:
      return keys.loginKey;
    case SecurityFlag.SESSION:
      if (!keys.sessionKey) {
        throw new Error('session_key not yet derived');
      }
      return keys.sessionKey;
    default:
      throw new Error(`unknown security flag 0x${(flag as number).toString(16)}`);
  }
}

export interface EncodePacketArgs {
  seqNum: number;
  responseTo: number;
  code: CommandCode;
  data: Buffer;
  securityFlag: SecurityFlag;
  keys: KeyBag;
  iv?: Buffer;
}

export function encodePacket(args: EncodePacketArgs): Buffer {
  const { seqNum, responseTo, code, data, securityFlag, keys } = args;
  const iv = args.iv ?? randomBytes(AES_BLOCK);

  const header = Buffer.alloc(12);
  header.writeUInt32BE(seqNum, 0);
  header.writeUInt32BE(responseTo, 4);
  header.writeUInt16BE(code, 8);
  header.writeUInt16BE(data.length, 10);

  const body = Buffer.concat([header, data]);
  const crc = crc16Modbus(body);
  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16BE(crc, 0);

  const padLen = (AES_BLOCK - ((body.length + 2) % AES_BLOCK)) % AES_BLOCK;
  const plaintext = Buffer.concat([body, crcBuf, Buffer.alloc(padLen)]);

  const key = selectKey(securityFlag, keys);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([Buffer.from([securityFlag]), iv, ciphertext]);
}

export function decodePacket(buf: Buffer, keys: KeyBag): ParsedPacket {
  if (buf.length < 1 + AES_BLOCK + AES_BLOCK) {
    throw new Error(`packet too short: ${buf.length} bytes`);
  }
  const securityFlag: SecurityFlag = buf[0];
  const iv = buf.subarray(1, 1 + AES_BLOCK);
  const ciphertext = buf.subarray(1 + AES_BLOCK);
  if (ciphertext.length % AES_BLOCK !== 0) {
    throw new Error(`ciphertext length ${ciphertext.length} not a multiple of ${AES_BLOCK}`);
  }

  const key = selectKey(securityFlag, keys);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (plaintext.length < 12 + 2) {
    throw new Error(`decrypted body too short: ${plaintext.length}`);
  }
  const seqNum = plaintext.readUInt32BE(0);
  const responseTo = plaintext.readUInt32BE(4);
  const code: CommandCode = plaintext.readUInt16BE(8);
  const dataLength = plaintext.readUInt16BE(10);

  if (12 + dataLength + 2 > plaintext.length) {
    throw new Error(`declared data length ${dataLength} exceeds buffer`);
  }
  const data = plaintext.subarray(12, 12 + dataLength);
  const expectedCrc = plaintext.readUInt16BE(12 + dataLength);
  const actualCrc = crc16Modbus(plaintext.subarray(0, 12 + dataLength));
  if (expectedCrc !== actualCrc) {
    throw new Error(
      `CRC mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`,
    );
  }

  return { seqNum, responseTo, code, data, securityFlag };
}

export function encodeDp(id: number, type: DpType, value: DpValue): Buffer {
  const valueBuf = encodeDpValue(type, value);
  if (valueBuf.length > 0xff) {
    throw new Error(`dp value too long: ${valueBuf.length} bytes`);
  }
  const out = Buffer.alloc(3 + valueBuf.length);
  out[0] = id & 0xff;
  out[1] = type & 0xff;
  out[2] = valueBuf.length & 0xff;
  valueBuf.copy(out, 3);
  return out;
}

export function encodeDps(dps: Datapoint[]): Buffer {
  return Buffer.concat(dps.map((d) => encodeDp(d.id, d.type, d.value)));
}

export function decodeDps(data: Buffer): Datapoint[] {
  const out: Datapoint[] = [];
  let pos = 0;
  while (data.length - pos >= 3) {
    const id = data[pos];
    const type: DpType = data[pos + 1];
    const len = data[pos + 2];
    if (pos + 3 + len > data.length) {
      break;
    }
    const raw = data.subarray(pos + 3, pos + 3 + len);
    out.push({ id, type, value: decodeDpValue(type, raw) });
    pos += 3 + len;
  }
  return out;
}

function encodeDpValue(type: DpType, value: DpValue): Buffer {
  switch (type) {
    case DpType.RAW:
    case DpType.BITMAP:
      if (!Buffer.isBuffer(value)) {
        throw new Error('raw/bitmap dp value must be a Buffer');
      }
      return value;
    case DpType.BOOL: {
      const b = Buffer.alloc(1);
      b[0] = value ? 1 : 0;
      return b;
    }
    case DpType.VALUE: {
      if (typeof value !== 'number') {
        throw new Error('value-type dp must be a number');
      }
      const b = Buffer.alloc(4);
      b.writeInt32BE(value | 0, 0);
      return b;
    }
    case DpType.STRING:
      if (typeof value !== 'string') {
        throw new Error('string dp value must be a string');
      }
      return Buffer.from(value, 'utf8');
    case DpType.ENUM: {
      if (typeof value !== 'number') {
        throw new Error('enum dp value must be a number');
      }
      if (value > 0xffff) {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(value >>> 0, 0);
        return b;
      }
      if (value > 0xff) {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(value, 0);
        return b;
      }
      return Buffer.from([value & 0xff]);
    }
    default:
      throw new Error(`unknown dp type ${type as number}`);
  }
}

function decodeDpValue(type: DpType, raw: Buffer): DpValue {
  switch (type) {
    case DpType.RAW:
    case DpType.BITMAP:
      return Buffer.from(raw);
    case DpType.BOOL:
      return raw.length > 0 && raw[0] !== 0;
    case DpType.VALUE:
      if (raw.length !== 4) {
        throw new Error(`value dp expects 4 bytes, got ${raw.length}`);
      }
      return raw.readInt32BE(0);
    case DpType.STRING:
      return raw.toString('utf8');
    case DpType.ENUM:
      if (raw.length === 1) return raw[0];
      if (raw.length === 2) return raw.readUInt16BE(0);
      if (raw.length === 4) return raw.readUInt32BE(0);
      throw new Error(`enum dp unexpected length ${raw.length}`);
    default:
      throw new Error(`unknown dp type ${type as number}`);
  }
}

export function packLeb128(value: number): Buffer {
  if (value < 0) {
    throw new Error('leb128 value must be non-negative');
  }
  const out: number[] = [];
  while (value >= 0x80) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value & 0x7f);
  return Buffer.from(out);
}

export function unpackLeb128(buf: Buffer, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let i = 0;
  while (offset + i < buf.length) {
    const byte = buf[offset + i];
    value |= (byte & 0x7f) << shift;
    i++;
    if ((byte & 0x80) === 0) {
      return { value, bytesRead: i };
    }
    shift += 7;
    if (shift >= 32) {
      throw new Error('leb128 value too long');
    }
  }
  throw new Error('leb128 truncated');
}

export function fragmentForBle(packet: Buffer, mtu: number): Buffer[] {
  // Tuya BLE fragments are numbered 0, 1, 2, … *per packet* (resets every send).
  // Fragment 0 also carries a leb128 total-length field and a protocol-version byte.
  // The python-tuya-ble reference code in `_send_packet` does the same.
  const chunks: Buffer[] = [];
  let pos = 0;
  let packetNum = 0;
  do {
    const headerParts: Buffer[] = [packLeb128(packetNum)];
    if (packetNum === 0) {
      headerParts.push(packLeb128(packet.length));
      headerParts.push(Buffer.from([(PROTOCOL_VERSION & 0x0f) << 4]));
    }
    const header = Buffer.concat(headerParts);
    const room = mtu - header.length;
    if (room <= 0) {
      throw new Error('mtu too small for fragment header');
    }
    const slice = packet.subarray(pos, pos + room);
    chunks.push(Buffer.concat([header, slice]));
    pos += slice.length;
    packetNum++;
  } while (pos < packet.length);
  return chunks;
}

export class BleReassembler {
  private expectedLength = 0;
  private received: Buffer[] = [];
  private receivedBytes = 0;

  feed(chunk: Buffer): Buffer | null {
    if (chunk.length === 0) return null;
    let pos = 0;
    const first = unpackLeb128(chunk, pos);
    pos += first.bytesRead;
    if (first.value === 0) {
      const lengthField = unpackLeb128(chunk, pos);
      pos += lengthField.bytesRead;
      pos += 1;
      this.reset();
      this.expectedLength = lengthField.value;
    } else if (this.expectedLength === 0) {
      return null;
    }
    const payload = chunk.subarray(pos);
    this.received.push(payload);
    this.receivedBytes += payload.length;
    if (this.receivedBytes >= this.expectedLength && this.expectedLength > 0) {
      const out = Buffer.concat(this.received, this.expectedLength);
      this.reset();
      return out;
    }
    return null;
  }

  reset(): void {
    this.expectedLength = 0;
    this.received = [];
    this.receivedBytes = 0;
  }
}

export function buildPairPayload(uuid: string, localKey: string, deviceId: string): Buffer {
  const buf = Buffer.alloc(44);
  Buffer.from(uuid, 'utf8').copy(buf, 0, 0, Math.min(16, uuid.length));
  Buffer.from(localKey, 'utf8').copy(buf, 16, 0, Math.min(6, localKey.length));
  Buffer.from(deviceId, 'utf8').copy(buf, 22, 0, Math.min(22, deviceId.length));
  return buf;
}

export function parseDeviceInfoResponse(data: Buffer): {
  protocolVersion: number;
  srand: Buffer;
  authKey: Buffer;
} {
  if (data.length < 46) {
    throw new Error(`device_info response too short: ${data.length}`);
  }
  return {
    protocolVersion: data[0],
    srand: Buffer.from(data.subarray(6, 12)),
    authKey: Buffer.from(data.subarray(14, 46)),
  };
}

function md5(...parts: Buffer[]): Buffer {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return h.digest();
}
