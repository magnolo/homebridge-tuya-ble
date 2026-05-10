# homebridge-tuya-ble-lock

Bridges **Tuya BLE-only smart locks** to HomeKit through a Homebridge instance running on a Raspberry Pi 3 (or any Linux box with BlueZ). The Pi takes the role normally played by the Smart Life app on a phone in BLE range.

> Status: alpha. Lock-only. Tested against the protocol layer of [`PlusPlus-ua/python-tuya-ble`](https://github.com/PlusPlus-ua/python-tuya-ble).

## Why this exists

Tuya sells locks that only speak BLE — they have no Wi-Fi, no Zigbee, and no native HomeKit support. Without a paid Tuya BLE gateway they're useless when your phone isn't in the room. This plugin turns the Raspberry Pi already running Homebridge into that gateway.

## Requirements

- Raspberry Pi 3 (or newer) with built-in BLE, running Raspberry Pi OS **Bookworm or later** (BlueZ ≥ 5.66).
- **Homebridge ≥ 2.0**, **Node 22 or 24** (Homebridge 2 requires `^22 || ^24`).
- A Tuya IoT Platform account (free) with the lock paired in the Smart Life app and accessible via the Cloud → Development → API Explorer.

## Install

```bash
sudo npm install -g homebridge-tuya-ble-lock
```

System packages and BlueZ permissions:

```bash
sudo apt install -y bluez
sudo usermod -aG bluetooth homebridge
```

Drop a D-Bus policy file so the `homebridge` user can talk to `org.bluez`:

```bash
sudo tee /etc/dbus-1/system.d/homebridge-ble.conf <<'EOF'
<!DOCTYPE busconfig PUBLIC
 "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="homebridge">
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.Adapter1"/>
    <allow send_interface="org.bluez.Device1"/>
    <allow send_interface="org.bluez.GattService1"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
EOF
sudo systemctl reload dbus
sudo systemctl restart homebridge
```

This plugin uses [`node-ble`](https://github.com/chrvadala/node-ble), which talks to BlueZ via D-Bus. **You do not need `setcap cap_net_raw+eip` on `node`** — that's only required for `noble`-based plugins which open raw HCI sockets directly. If you've previously set that capability, leaving it in place is harmless.

## Getting your lock's credentials

For each lock you want to bridge:

1. Pair it in the **Smart Life** app as usual.
2. Sign up at <https://iot.tuya.com> and link your Smart Life account (Cloud → Link Tuya App Account).
3. Open API Explorer → `/v2.0/cloud/thing/{device_id}` to see `device_id`, `uuid`, `local_key`, and `mac`.
4. Paste those values into the Homebridge plugin config.

If you ever re-pair the lock in the Smart Life app, **`local_key` rotates** — you'll need to fetch the new value and update the config.

## Configuration

Add via the Homebridge UI (Plugins → Tuya BLE Lock → Settings) or by hand in `config.json`:

```jsonc
{
  "platforms": [
    {
      "platform": "TuyaBLELock",
      "name": "Tuya BLE Locks",
      "locks": [
        {
          "name": "Front Door",
          "mac": "AA:BB:CC:DD:EE:FF",
          "uuid": "tuya0123456789ab",
          "device_id": "bf1234567890abcdef",
          "local_key": "abcdef0123456789"
        }
      ]
    }
  ]
}
```

Advanced fields (only set if defaults don't work for your lock model):

| Field | Default | Notes |
|---|---|---|
| `lockDpId` | `47` | Datapoint id used to lock/unlock. See "Finding your DP ids" below. |
| `lockInverted` | `false` | Set to `true` if HomeKit reports the lock state inverted from reality. |
| `batteryLevelDpId` | `9` | Datapoint id reporting battery level (0–100). |
| `batteryStateDpId` | `8` | Fallback datapoint reporting battery state (low/med/high). |
| `idleDisconnectMs` | `15000` | Disconnect after this much idle. `0` = stay connected (drains battery). |
| `dpsLogLevel` | `info` | `off`, `info` (every received DP), or `debug` (every packet). |

## Finding your DP ids

DP id `47` works for most current Tuya BLE locks but firmware varies. To discover yours:

1. Set `dpsLogLevel: "info"` in plugin config and restart Homebridge.
2. Lock and unlock the device once from the Tuya/Smart Life app.
3. Watch the Homebridge log:

```
[Tuya BLE Locks] [AA:BB:CC:DD:EE:FF] dp id=47 type=1 value=true
[Tuya BLE Locks] [AA:BB:CC:DD:EE:FF] dp id=8  type=4 value=2
[Tuya BLE Locks] [AA:BB:CC:DD:EE:FF] dp id=9  type=2 value=87
```

The `id` that toggles when you lock/unlock is your `lockDpId`. Battery DPs are usually a small int (level) or a 0/1/2 enum (state).

## Connection model

Locks deep-sleep to save battery. The plugin connects on demand, runs the operation (or reads the current state), then disconnects after 15 s of idle. Side effect: state changes made at the lock itself (keypad, fingerprint) **don't appear in HomeKit until the next interaction**. This is intentional — holding the connection open drains both lock and Pi radio for marginal benefit.

## Limitations

- **One BLE radio.** The Pi 3's BCM43438 has a single BLE radio; the plugin serializes all GATT operations across all configured locks. With a few locks, latency is fine; with a dozen it'll get sluggish.
- **Lock category only.** Smart bulbs, sensors, and other Tuya BLE devices are out of scope.
- **No pairing flow.** This plugin does not pair locks — it only talks to ones already paired in Smart Life.
- **Wake-only locks.** Some fingerprint-only locks don't advertise until you touch them. Lock/unlock from HomeKit will simply time out and retry until the lock is awake.
- **Some FD50-service locks (e.g. Tuya 8052Y / `lxyrmroq`) are not supported for unlock.** This appears to be either an older Tuya BLE SDK version, the separate Tuya BLE Lock SDK, or a different cipher mode entirely — we couldn't pin down which without ground-truth source. What's verified: these locks use security flag bytes `0x0E` / `0x0F` and a key derivation that isn't `MD5(local_key[:6])` (which python-tuya-ble's SDK-3.x A201 family uses). None of MD5/HMAC/SHA1/SHA256 of `local_key`, `uuid`, `device_id`, or concatenations decrypt the captured AES-CBC ciphertext to anything plausible. The plugin connects fine, finds the right GATT service + characteristic, sends a correctly framed packet — the lock just rejects it because we can't generate the right AES key.

  Set `monitorOnly: true` in the lock's config to suppress the failed connect attempts and use the **homebridge-tuya cloud plugin** for status visibility (battery, unlock events, alarms, doorbell). See the section below.

## Read-only status for unsupported FD50 locks via the cloud plugin

If your lock falls into the unsupported category above, the [homebridge-tuya](https://github.com/homebridge-plugins/homebridge-tuya) cloud plugin already polls the lock's DPs from Tuya's cloud — battery (`residual_electricity`), unlock counters (`unlock_fingerprint`, `unlock_password`, `unlock_card`, `unlock_ble`), alarms (`alarm_lock`), doorbell. By default it marks the device "unsupported" because there's no `lock_motor_state` DP, but you can manually map the read-only DPs with `deviceOverrides`. Example block to add to the **homebridge-tuya** plugin config (NOT this plugin's config):

```jsonc
{
  "platform": "TuyaPlatform",
  // ... your existing options ...
  "deviceOverrides": [
    {
      "id": "<your_device_id>",
      "category": "rs",
      "schema": [
        { "code": "battery_state", "id": "9", "type": "Integer", "values": "{\"min\":0,\"max\":100,\"scale\":0,\"step\":1,\"unit\":\"%\"}" }
      ]
    }
  ]
}
```

(Field names depend on your homebridge-tuya version — see its FAQ. The principle is: forcibly map `residual_electricity` to a `battery_state`-style schema entry the plugin knows how to render as a HomeKit `Battery` service.)

For unlock notifications, watch the `unlock_*` event counters; each increments when someone unlocks via that method. You can wire those to HomeKit Stateless Programmable Switches via the cloud plugin's override schema or via a separate Homebridge automation plugin.

This plugin in `monitorOnly: true` mode will keep a HomeKit Lock tile published (so it stays referenced in your Home app rooms / scenes) but won't try to talk BLE — eliminating the failed-connect log noise.

## Troubleshooting

- `BlueZ adapter unavailable` — `bluetoothd` is not running or D-Bus policy is missing. Check `systemctl status bluetooth` and the policy file above.
- `pair rejected ... local_key may be stale` — re-fetch credentials from cloud.tuya.com. Most common after re-pairing in the Smart Life app.
- `timeout waiting for code 0x0000` during connect — lock is asleep. Wake it (touch a button, swipe a finger) and the plugin will reconnect.
- Repeated disconnects — try `sudo systemctl restart bluetooth`. If it persists, raise an issue with `dpsLogLevel: "debug"` log lines.

## Development

```bash
npm install
npm run build
npm test
```

Manual integration test plan: see [`test/MANUAL.md`](test/MANUAL.md).

## License

MIT.
