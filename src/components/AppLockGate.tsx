import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import SchoolLockScreen from './SchoolLockScreen';
import { evaluateSchoolLock, SchoolLockStatus } from '../utils/schoolLock';

interface AppLockGateProps {
  children: React.ReactNode;
}

const CHECK_INTERVAL_MS = 30000;

const AppLockGate: React.FC<AppLockGateProps> = ({ children }) => {
  const [status, setStatus] = useState<SchoolLockStatus>({ shouldLock: false });
  const [overrideActive, setOverrideActive] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const checkingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const nextStatus = await evaluateSchoolLock();
      setStatus(nextStatus);
      if (!nextStatus.shouldLock) {
        setOverrideActive(false);
      }
    } finally {
      setInitialized(true);
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    refresh().catch(error => console.warn('[AppLockGate] Initial lock check failed:', error));
    const interval = setInterval(refresh, CHECK_INTERVAL_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refresh().catch(error => console.warn('[AppLockGate] Foreground lock check failed:', error));
      }
    });

    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [refresh]);

  if (!initialized) {
    return <View style={styles.container} />;
  }

  if (status.shouldLock && !overrideActive) {
    return (
      <SchoolLockScreen
        currentSsid={status.visibleSsid || status.currentSsid}
        onUnlocked={() => setOverrideActive(true)}
      />
    );
  }

  return <View style={styles.container}>{children}</View>;
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default AppLockGate;
