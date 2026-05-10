export function crc16Modbus(data: Buffer | Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] & 0xff;
    for (let j = 0; j < 8; j++) {
      const lsb = crc & 1;
      crc >>>= 1;
      if (lsb) {
        crc ^= 0xa001;
      }
    }
  }
  return crc & 0xffff;
}
