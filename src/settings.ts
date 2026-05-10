export const PLUGIN_NAME = 'homebridge-tuya-ble-lock';
export const PLATFORM_NAME = 'TuyaBLELock';

export interface GattProfile {
  service: string;
  notify: string;
  write: string;
}

// Known Tuya BLE GATT layouts. Tried in order; first one that the lock exposes wins.
// - "fd50" is the older/larger family (vendor-specific 0xFD50 service, 16-bit-ish chars)
// - "a201" is the newer SDK family (16-bit 0xA201 service, 0x2B10 notify, 0x2B11 write)
export const TUYA_GATT_PROFILES: ReadonlyArray<GattProfile> = [
  {
    service: '0000fd50-0000-1000-8000-00805f9b34fb',
    notify: '00000002-0000-1001-8001-00805f9b07d0',
    write: '00000003-0000-1001-8001-00805f9b07d0',
  },
  {
    service: '0000a201-0000-1000-8000-00805f9b34fb',
    notify: '00002b10-0000-1000-8000-00805f9b34fb',
    write: '00002b11-0000-1000-8000-00805f9b34fb',
  },
];

export const GATT_MTU = 20;
export const PROTOCOL_VERSION = 3;
