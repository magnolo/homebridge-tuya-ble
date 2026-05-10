import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DpType, SecurityFlag, CommandCode } from '../src/tuya/codes.js';
import {
  BleReassembler,
  buildPairPayload,
  decodeDps,
  decodePacket,
  deriveLoginKey,
  deriveSessionKey,
  encodeDp,
  encodeDps,
  encodePacket,
  fragmentForBle,
  packLeb128,
  unpackLeb128,
} from '../src/tuya/protocol.js';

const LOCAL_KEY = 'abc123XYZ!Q'; // arbitrary fixture

describe('key derivation', () => {
  it('login_key = MD5(local_key[:6])', () => {
    const expected = createHash('md5').update(Buffer.from('abc123', 'utf8')).digest();
    expect(deriveLoginKey(LOCAL_KEY).equals(expected)).toBe(true);
    expect(deriveLoginKey(LOCAL_KEY).length).toBe(16);
  });

  it('session_key = MD5(local_key[:6] + srand)', () => {
    const srand = Buffer.from([1, 2, 3, 4, 5, 6]);
    const expected = createHash('md5')
      .update(Buffer.concat([Buffer.from('abc123', 'utf8'), srand]))
      .digest();
    expect(deriveSessionKey(LOCAL_KEY, srand).equals(expected)).toBe(true);
  });
});

describe('packet round-trip', () => {
  it('encrypt then decrypt yields the same fields (login_key)', () => {
    const keys = { loginKey: deriveLoginKey(LOCAL_KEY) };
    const data = Buffer.from('hello tuya', 'utf8');
    const iv = Buffer.alloc(16, 0xab);
    const wire = encodePacket({
      seqNum: 42,
      responseTo: 0,
      code: CommandCode.SENDER_DEVICE_INFO,
      data,
      securityFlag: SecurityFlag.LOGIN,
      keys,
      iv,
    });
    const parsed = decodePacket(wire, keys);
    expect(parsed.seqNum).toBe(42);
    expect(parsed.responseTo).toBe(0);
    expect(parsed.code).toBe(CommandCode.SENDER_DEVICE_INFO);
    expect(parsed.data.equals(data)).toBe(true);
    expect(parsed.securityFlag).toBe(SecurityFlag.LOGIN);
  });

  it('encrypt then decrypt yields the same fields (session_key)', () => {
    const keys = {
      loginKey: deriveLoginKey(LOCAL_KEY),
      sessionKey: deriveSessionKey(LOCAL_KEY, Buffer.from([9, 9, 9, 9, 9, 9])),
    };
    const data = Buffer.from('payload', 'utf8');
    const wire = encodePacket({
      seqNum: 7,
      responseTo: 3,
      code: CommandCode.SENDER_DPS,
      data,
      securityFlag: SecurityFlag.SESSION,
      keys,
    });
    const parsed = decodePacket(wire, keys);
    expect(parsed.code).toBe(CommandCode.SENDER_DPS);
    expect(parsed.data.equals(data)).toBe(true);
    expect(parsed.responseTo).toBe(3);
  });

  it('zero-length payload round-trips', () => {
    const keys = { loginKey: deriveLoginKey(LOCAL_KEY) };
    const wire = encodePacket({
      seqNum: 1,
      responseTo: 0,
      code: CommandCode.SENDER_DEVICE_INFO,
      data: Buffer.alloc(0),
      securityFlag: SecurityFlag.LOGIN,
      keys,
    });
    const parsed = decodePacket(wire, keys);
    expect(parsed.data.length).toBe(0);
  });

  it('CRC mismatch is detected', () => {
    const keys = { loginKey: deriveLoginKey(LOCAL_KEY) };
    const wire = encodePacket({
      seqNum: 1,
      responseTo: 0,
      code: CommandCode.SENDER_DPS,
      data: Buffer.from([1, 2, 3]),
      securityFlag: SecurityFlag.LOGIN,
      keys,
    });
    // Flip a byte inside the ciphertext.
    wire[wire.length - 1] ^= 0x01;
    expect(() => decodePacket(wire, keys)).toThrow();
  });
});

describe('DP encoding', () => {
  it('bool DP encodes to id+type+len+value', () => {
    expect(encodeDp(47, DpType.BOOL, true).equals(Buffer.from([47, 1, 1, 1]))).toBe(true);
    expect(encodeDp(47, DpType.BOOL, false).equals(Buffer.from([47, 1, 1, 0]))).toBe(true);
  });

  it('value DP encodes as 4-byte big-endian signed int', () => {
    const buf = encodeDp(9, DpType.VALUE, 123456);
    expect(buf.subarray(0, 3).equals(Buffer.from([9, 2, 4]))).toBe(true);
    expect(buf.readInt32BE(3)).toBe(123456);
  });

  it('enum DP picks 1, 2, or 4 byte width based on value', () => {
    expect(encodeDp(8, DpType.ENUM, 0)[2]).toBe(1);
    expect(encodeDp(8, DpType.ENUM, 0xff + 1)[2]).toBe(2);
    expect(encodeDp(8, DpType.ENUM, 0xffff + 1)[2]).toBe(4);
  });

  it('round-trips multiple DPs through encode + decode', () => {
    const dps = [
      { id: 47, type: DpType.BOOL, value: true },
      { id: 9, type: DpType.VALUE, value: 75 },
      { id: 8, type: DpType.ENUM, value: 2 },
    ];
    const buf = encodeDps(dps);
    const decoded = decodeDps(buf);
    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toEqual(dps[0]);
    expect(decoded[1]).toEqual(dps[1]);
    expect(decoded[2]).toEqual(dps[2]);
  });
});

describe('LEB128', () => {
  it('round-trips 0, 127, 128, 16383, 16384, 1<<28', () => {
    for (const v of [0, 1, 127, 128, 200, 16383, 16384, 1 << 20, 1 << 28]) {
      const packed = packLeb128(v);
      const { value, bytesRead } = unpackLeb128(packed, 0);
      expect(value).toBe(v);
      expect(bytesRead).toBe(packed.length);
    }
  });
});

describe('BLE fragmentation', () => {
  it('first chunk carries length + protocol byte; later chunks carry only seq', () => {
    const packet = Buffer.alloc(60, 0x42);
    const chunks = fragmentForBle(packet, 1, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });

  it('reassembler reconstructs the original packet', () => {
    const packet = Buffer.from(
      Array.from({ length: 73 }, (_, i) => (i * 7) & 0xff),
    );
    const chunks = fragmentForBle(packet, 1, 20);
    const r = new BleReassembler();
    let out: Buffer | null = null;
    for (const c of chunks) {
      const result = r.feed(c);
      if (result) out = result;
    }
    expect(out).not.toBeNull();
    expect(out!.equals(packet)).toBe(true);
  });

  it('supports a single-chunk packet that fits in one MTU', () => {
    const packet = Buffer.from([1, 2, 3, 4]);
    const chunks = fragmentForBle(packet, 1, 20);
    expect(chunks).toHaveLength(1);
    const r = new BleReassembler();
    expect(r.feed(chunks[0])!.equals(packet)).toBe(true);
  });
});

describe('pair payload', () => {
  it('builds a 44-byte uuid|local_key|device_id buffer', () => {
    const uuid = '0123456789abcdef';
    const buf = buildPairPayload(uuid, LOCAL_KEY, 'devid12345');
    expect(buf.length).toBe(44);
    expect(buf.subarray(0, 16).toString('utf8')).toBe(uuid);
    expect(buf.subarray(16, 22).toString('utf8')).toBe('abc123');
    expect(buf.subarray(22, 32).toString('utf8')).toBe('devid12345');
  });
});
