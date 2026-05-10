# Manual integration test checklist

Run these on a Raspberry Pi 3 with the plugin installed against a real Tuya BLE lock.

## Setup

1. Pair lock in Smart Life app.
2. Fetch `device_id`, `uuid`, `local_key`, `mac` from cloud.tuya.com → API Explorer → `/v2.0/cloud/thing/{device_id}`.
3. Configure platform via Homebridge UI with `dpsLogLevel: info`.
4. Restart Homebridge.

## Tests

- [ ] **Connect.** First HomeKit read causes the plugin to scan, connect, run auth, and emit DP logs within 15 s. No errors.
- [ ] **Lock from HomeKit.** Tap "Lock" — motor turns within ~3 s, Home app updates to "Locked".
- [ ] **Unlock from HomeKit.** Tap "Unlock" — motor turns, Home app updates to "Unlocked".
- [ ] **Manual lock at the device.** Lock with the keypad/fingerprint; trigger any HomeKit interaction; current state should reconcile within 10 s.
- [ ] **Battery service.** `BatteryLevel` characteristic shows a plausible percentage. Trigger low-battery by configuring `batteryLevelDpId` to a fake high-id and verify `StatusLowBattery` defaults safely.
- [ ] **BlueZ recovery.** `sudo systemctl restart bluetooth`; plugin recovers and next HomeKit op succeeds within 30 s.
- [ ] **Pi reboot.** Reboot the Pi; after Homebridge restarts, lock is still controllable.
- [ ] **Stale local_key.** Re-pair the lock in the Tuya app (which rotates `local_key`). Plugin should log `pair rejected ... local_key may be stale` rather than silently looping.
- [ ] **Idle disconnect.** After a successful op, wait 15+ s; plugin logs `idle timeout; disconnecting` and the lock LED reflects disconnection (model-dependent).
- [ ] **Multiple locks.** Configure two locks; lock both in HomeKit nearly simultaneously; ops complete sequentially without crashing BlueZ.
