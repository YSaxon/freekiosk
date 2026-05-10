import { NativeModules } from 'react-native';
import { StorageService } from './storage';

const { WifiControlModule } = NativeModules;

export interface SchoolLockConfig {
  enabled: boolean;
  wifiSsid: string;
  startTime: string;
  endTime: string;
  days: number[];
}

export interface SchoolLockStatus {
  shouldLock: boolean;
  reason?: string;
  currentSsid?: string;
  visibleSsid?: string;
}

const normalizeSsid = (ssid: string): string => ssid.replace(/^"|"$/g, '').trim();

const parseMinutes = (time: string): number | null => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
};

const isWithinWindow = (now: Date, startTime: string, endTime: string): boolean => {
  const start = parseMinutes(startTime);
  const end = parseMinutes(endTime);
  if (start === null || end === null || start === end) return false;

  const current = now.getHours() * 60 + now.getMinutes();
  if (start < end) {
    return current >= start && current < end;
  }

  return current >= start || current < end;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const scanForVisibleSsid = async (targetSsid: string): Promise<boolean | null> => {
  if (!WifiControlModule?.getScanResults) {
    return null;
  }

  const hasTarget = (results: Array<{ ssid?: string }> | null | undefined): boolean =>
    Boolean(results?.some(network => normalizeSsid(network?.ssid ?? '') === targetSsid));

  try {
    const cachedResults = await WifiControlModule.getScanResults();
    if (hasTarget(cachedResults)) {
      return true;
    }

    if (!WifiControlModule?.startScan) {
      return false;
    }

    await WifiControlModule.startScan();
    await delay(3500);
    const freshResults = await WifiControlModule.getScanResults();
    return hasTarget(freshResults);
  } catch (error) {
    console.warn('[SchoolLock] Unable to scan Wi-Fi networks:', error);
    return null;
  }
};

export const loadSchoolLockConfig = async (): Promise<SchoolLockConfig> => {
  const [enabled, wifiSsid, startTime, endTime, days] = await Promise.all([
    StorageService.getSchoolLockEnabled(),
    StorageService.getSchoolLockWifiSsid(),
    StorageService.getSchoolLockStartTime(),
    StorageService.getSchoolLockEndTime(),
    StorageService.getSchoolLockDays(),
  ]);

  return {
    enabled,
    wifiSsid,
    startTime,
    endTime,
    days,
  };
};

export const evaluateSchoolLock = async (now = new Date()): Promise<SchoolLockStatus> => {
  const config = await loadSchoolLockConfig();
  if (!config.enabled) {
    return { shouldLock: false, reason: 'disabled' };
  }

  const targetSsid = normalizeSsid(config.wifiSsid);
  if (!targetSsid) {
    return { shouldLock: false, reason: 'missing_ssid' };
  }

  if (!config.days.includes(now.getDay())) {
    return { shouldLock: false, reason: 'outside_days' };
  }

  if (!isWithinWindow(now, config.startTime, config.endTime)) {
    return { shouldLock: false, reason: 'outside_hours' };
  }

  const isVisible = await scanForVisibleSsid(targetSsid);
  if (isVisible !== null) {
    return {
      shouldLock: isVisible,
      reason: isVisible ? 'ssid_visible' : 'ssid_not_visible',
      visibleSsid: isVisible ? targetSsid : undefined,
    };
  }

  if (!WifiControlModule?.getWifiInfo) {
    return { shouldLock: false, reason: 'wifi_unavailable' };
  }

  // Fail open when scans are unavailable, but still support connected SSID as a fallback.
  try {
    const info = await WifiControlModule.getWifiInfo();
    const currentSsid = normalizeSsid(info?.ssid ?? '');
    return {
      shouldLock: Boolean(info?.isConnected) && currentSsid === targetSsid,
      reason: currentSsid === targetSsid ? 'matched' : 'ssid_mismatch',
      currentSsid,
    };
  } catch (error) {
    console.warn('[SchoolLock] Unable to read Wi-Fi info:', error);
    return { shouldLock: false, reason: 'wifi_error' };
  }
};
