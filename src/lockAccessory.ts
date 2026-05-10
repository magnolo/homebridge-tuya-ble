import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { DpType } from './tuya/codes.js';
import type { TuyaBLEDevice } from './tuya/device.js';
import type { Datapoint, LockConfig } from './tuya/types.js';
import type { TuyaBLEPlatform } from './platform.js';

const DEFAULT_LOCK_DP_ID = 47;
const DEFAULT_BATTERY_LEVEL_DP_ID = 9;
const DEFAULT_BATTERY_STATE_DP_ID = 8;

export class TuyaBLELockAccessory {
  private readonly lockService: Service;
  private readonly batteryService: Service;
  private readonly lockDpId: number;
  private readonly batteryLevelDpId: number;
  private readonly batteryStateDpId: number;
  private readonly lockInverted: boolean;
  private hasReceivedLockState = false;
  private lastBatteryLevel = 100;

  constructor(
    private readonly platform: TuyaBLEPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly cfg: LockConfig,
    private readonly device: TuyaBLEDevice,
  ) {
    this.lockDpId = cfg.lockDpId ?? DEFAULT_LOCK_DP_ID;
    this.batteryLevelDpId = cfg.batteryLevelDpId ?? DEFAULT_BATTERY_LEVEL_DP_ID;
    this.batteryStateDpId = cfg.batteryStateDpId ?? DEFAULT_BATTERY_STATE_DP_ID;
    this.lockInverted = cfg.lockInverted ?? false;

    const { Service, Characteristic } = this.platform.api.hap;

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Tuya')
      .setCharacteristic(Characteristic.Model, cfg.product_id ?? 'BLE Lock')
      .setCharacteristic(Characteristic.SerialNumber, cfg.device_id);

    this.lockService =
      this.accessory.getService(Service.LockMechanism) ??
      this.accessory.addService(Service.LockMechanism, cfg.name);

    this.lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .onSet(this.handleLockTargetSet.bind(this));

    this.lockService
      .getCharacteristic(Characteristic.LockCurrentState)
      .updateValue(Characteristic.LockCurrentState.SECURED);
    this.lockService
      .getCharacteristic(Characteristic.StatusActive)
      .updateValue(false);

    this.batteryService =
      this.accessory.getService(Service.Battery) ?? this.accessory.addService(Service.Battery);
    this.batteryService.setCharacteristic(
      Characteristic.ChargingState,
      Characteristic.ChargingState.NOT_CHARGEABLE,
    );

    this.device.on('dp', this.handleDp);
    this.device.on('state', () => {
      // Surface connectivity via StatusActive on the lock service.
      const ready = this.hasReceivedLockState;
      this.lockService
        .getCharacteristic(Characteristic.StatusActive)
        .updateValue(ready);
    });
  }

  private async handleLockTargetSet(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform.api.hap;
    if (this.cfg.monitorOnly) {
      // Read-only mode: surface the limitation cleanly to HomeKit without retrying.
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC,
      );
    }
    const target = Number(value);
    const secured = target === Characteristic.LockTargetState.SECURED;
    const dpValue = this.lockInverted ? secured : !secured;
    try {
      await this.device.sendDp(this.lockDpId, DpType.BOOL, dpValue);
    } catch (err) {
      this.platform.log.warn(
        `[${this.cfg.mac}] lock set failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.lockService
        .getCharacteristic(Characteristic.LockCurrentState)
        .updateValue(Characteristic.LockCurrentState.JAMMED);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.OPERATION_TIMED_OUT,
      );
    }
  }

  private handleDp = (dp: Datapoint): void => {
    const { Characteristic } = this.platform.api.hap;

    if (dp.id === this.lockDpId && typeof dp.value === 'boolean') {
      const motorEngaged = this.lockInverted ? dp.value : !dp.value;
      const currentState = motorEngaged
        ? Characteristic.LockCurrentState.SECURED
        : Characteristic.LockCurrentState.UNSECURED;
      const targetState = motorEngaged
        ? Characteristic.LockTargetState.SECURED
        : Characteristic.LockTargetState.UNSECURED;
      this.lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(currentState);
      this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(targetState);
      this.hasReceivedLockState = true;
      this.lockService.getCharacteristic(Characteristic.StatusActive).updateValue(true);
      return;
    }

    if (dp.id === this.batteryLevelDpId && typeof dp.value === 'number') {
      const level = clampPercent(dp.value);
      this.lastBatteryLevel = level;
      this.batteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(level);
      this.batteryService
        .getCharacteristic(Characteristic.StatusLowBattery)
        .updateValue(
          level < 20
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
      return;
    }

    if (dp.id === this.batteryStateDpId && typeof dp.value === 'number') {
      const level = batteryEnumToPercent(dp.value);
      if (level !== null && this.lastBatteryLevel === 100) {
        this.batteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(level);
      }
      this.batteryService
        .getCharacteristic(Characteristic.StatusLowBattery)
        .updateValue(
          dp.value === 0
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
    }
  };
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function batteryEnumToPercent(v: number): number | null {
  switch (v) {
    case 0:
      return 10;
    case 1:
      return 50;
    case 2:
      return 90;
    default:
      return null;
  }
}
