import { describe, expect, it } from 'vitest';

import { crc16Modbus } from '../src/tuya/crc.js';

describe('crc16Modbus', () => {
  it('matches MODBUS reference vector 01 03 00 00 00 0A → 0xCDC5', () => {
    // Reference: https://crccalc.com — CRC-16/MODBUS
    // The function returns the numerical 16-bit value;
    // on the wire MODBUS sends low byte first (C5 CD).
    expect(crc16Modbus(Buffer.from('01030000000a', 'hex'))).toBe(0xcdc5);
  });

  it('CRC of empty buffer is the initial value 0xFFFF', () => {
    expect(crc16Modbus(Buffer.alloc(0))).toBe(0xffff);
  });

  it('result is always 16-bit', () => {
    for (let i = 0; i < 256; i++) {
      const c = crc16Modbus(Buffer.from([i]));
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(0xffff);
    }
  });
});
