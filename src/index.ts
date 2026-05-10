import type { API } from 'homebridge';

import { TuyaBLEPlatform } from './platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export default function (api: API): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TuyaBLEPlatform);
}
