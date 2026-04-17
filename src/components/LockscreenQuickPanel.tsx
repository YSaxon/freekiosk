/**
 * LockscreenQuickPanel — swipe-down quick-access panel for WiFi / Bluetooth.
 *
 * Renders as an absolute-positioned overlay on top of the kiosk screen.
 * A narrow drag-handle strip sits at the very top edge; pulling it down
 * (or tapping it) reveals the panel.  Everything stays within the app —
 * no system Settings are opened, so kiosk isolation is preserved.
 *
 * Visibility of this component is controlled by the parent (KioskScreen):
 * it is only mounted when `swipeDownEnabled` is true in settings.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  Animated,
  PanResponder,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Platform,
} from 'react-native';
import WifiDialog from './WifiDialog';
import BluetoothDialog from './BluetoothDialog';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const HANDLE_HEIGHT = 20; // Thin drag target at top edge
const PANEL_HEIGHT = 100; // Expanded panel height
const DRAG_THRESHOLD = 30; // Minimum drag distance to open/close

interface Props {
  showWifi: boolean;
  showBluetooth: boolean;
}

export default function LockscreenQuickPanel({ showWifi, showBluetooth }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [wifiDialogVisible, setWifiDialogVisible] = useState(false);
  const [bluetoothDialogVisible, setBluetoothDialogVisible] = useState(false);
  const panelY = useRef(new Animated.Value(0)).current; // 0 = handle only, PANEL_HEIGHT = fully open

  const open = useCallback(() => {
    setIsOpen(true);
    Animated.spring(panelY, {
      toValue: PANEL_HEIGHT,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start();
  }, [panelY]);

  const close = useCallback(() => {
    Animated.spring(panelY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start(() => setIsOpen(false));
  }, [panelY]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 5,
      onPanResponderMove: (_, gs) => {
        const newY = Math.max(0, Math.min(PANEL_HEIGHT, gs.dy > 0 ? gs.dy : PANEL_HEIGHT + gs.dy));
        panelY.setValue(newY);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > DRAG_THRESHOLD) {
          open();
        } else if (gs.dy < -DRAG_THRESHOLD) {
          close();
        } else {
          // Snap back to current state
          Animated.spring(panelY, {
            toValue: gs.moveY < HANDLE_HEIGHT + PANEL_HEIGHT / 2 ? 0 : PANEL_HEIGHT,
            useNativeDriver: true,
          }).start((result) => {
            if (result.finished) {
              setIsOpen(gs.moveY >= HANDLE_HEIGHT + PANEL_HEIGHT / 2);
            }
          });
        }
      },
    })
  ).current;

  // Close panel when a dialog opens
  useEffect(() => {
    if (wifiDialogVisible || bluetoothDialogVisible) {
      close();
    }
  }, [wifiDialogVisible, bluetoothDialogVisible, close]);

  if (!showWifi && !showBluetooth) return null;

  return (
    <>
      {/* The drag handle + panel, absolutely positioned at the top */}
      <Animated.View
        style={[styles.panelWrapper, { transform: [{ translateY: Animated.subtract(panelY, new Animated.Value(0)) }] }]}
        {...panResponder.panHandlers}
      >
        {/* Drag handle bar */}
        <TouchableOpacity
          style={styles.handle}
          onPress={() => (isOpen ? close() : open())}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 0, right: 0 }}
        >
          <View style={styles.handleBar} />
        </TouchableOpacity>

        {/* Expanded panel content */}
        <Animated.View
          style={[
            styles.panel,
            {
              opacity: panelY.interpolate({
                inputRange: [0, PANEL_HEIGHT * 0.4, PANEL_HEIGHT],
                outputRange: [0, 0.6, 1],
              }),
            },
          ]}
          pointerEvents={isOpen ? 'auto' : 'none'}
        >
          <View style={styles.panelContent}>
            {showWifi && (
              <TouchableOpacity
                style={styles.panelBtn}
                onPress={() => setWifiDialogVisible(true)}
              >
                <Text style={styles.panelBtnIcon}>📶</Text>
                <Text style={styles.panelBtnLabel}>Wi-Fi</Text>
              </TouchableOpacity>
            )}
            {showBluetooth && (
              <TouchableOpacity
                style={styles.panelBtn}
                onPress={() => setBluetoothDialogVisible(true)}
              >
                <Text style={styles.panelBtnIcon}>🔵</Text>
                <Text style={styles.panelBtnLabel}>Bluetooth</Text>
              </TouchableOpacity>
            )}
          </View>
        </Animated.View>
      </Animated.View>

      {/* Dialogs rendered at root level so they cover the full screen */}
      <WifiDialog
        visible={wifiDialogVisible}
        onClose={() => setWifiDialogVisible(false)}
      />
      <BluetoothDialog
        visible={bluetoothDialogVisible}
        onClose={() => setBluetoothDialogVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  panelWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9000,
    // translateY starts at 0 (only handle visible) and grows to PANEL_HEIGHT
    // We position the container so the handle is always at the top edge
    // and the panel hangs below it.
    transform: [{ translateY: -(PANEL_HEIGHT) }],
  },
  handle: {
    height: HANDLE_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderBottomLeftRadius: 4,
    borderBottomRightRadius: 4,
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
  panel: {
    height: PANEL_HEIGHT,
    backgroundColor: 'rgba(20,20,20,0.92)',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  panelContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  panelBtn: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    minWidth: 80,
  },
  panelBtnIcon: {
    fontSize: 26,
    marginBottom: 4,
  },
  panelBtnLabel: {
    fontSize: 12,
    color: '#fff',
    fontWeight: '600',
  },
});
