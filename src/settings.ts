export const PLUGIN_NAME = 'homebridge-tuya-ble-lock';
export const PLATFORM_NAME = 'TuyaBLELock';

export interface GattProfile {
  service: string;
  notify: string;
  write: string;
}

// Known Tuya BLE GATT layouts. Tried in order; first one that the lock exposes wins.
//
// FD50 (older, SDK 2.x): vendor service + three vendor characteristics. Confirmed via
// HCI snoop of the official Tuya app talking to a 8052Y / lxyrmroq lock — the app writes
// to 0x00000001 (NOT 0x00000003 as some incomplete references suggest) and reads
// notifications from 0x00000002. The 0x00000003 characteristic is unused by the app.
//
// A201 (newer, SDK 3.x): 16-bit 0xA201 service with 0x2B10 (notify) / 0x2B11 (write).
export const TUYA_GATT_PROFILES: ReadonlyArray<GattProfile> = [
  {
    service: '0000fd50-0000-1000-8000-00805f9b34fb',
    notify: '00000002-0000-1001-8001-00805f9b07d0',
    write: '00000001-0000-1001-8001-00805f9b07d0',
  },
  {
    service: '0000a201-0000-1000-8000-00805f9b34fb',
    notify: '00002b10-0000-1000-8000-00805f9b34fb',
    write: '00002b11-0000-1000-8000-00805f9b34fb',
  },
];

export const GATT_MTU = 20;
export const PROTOCOL_VERSION = 3;
