/**
 * LockscreenQuickPanel — swipe-down quick-access panel.
 *
 * Drag handle at the very top edge; pull down to reveal rows for:
 *   • WiFi / Bluetooth launch buttons (open full-screen dialogs)
 *   • Audio: mute toggle, volume slider, output selector
 *
 * Nothing here opens the system Settings app — kiosk isolation is preserved.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  Animated,
  PanResponder,
  TouchableOpacity,
  StyleSheet,
  NativeModules,
  Modal,
  FlatList,
} from 'react-native';
import Slider from '@react-native-community/slider';
import WifiDialog from './WifiDialog';
import BluetoothDialog from './BluetoothDialog';

const { AudioControlModule } = NativeModules;

const HANDLE_HEIGHT = 20;
const ROW_HEIGHT = 80; // height per content row
const DRAG_THRESHOLD = 28;

// Output type → icon mapping (text-based, no extra icon library needed)
const OUTPUT_ICONS: Record<string, string> = {
  auto: '🔈',
  speaker: '🔊',
  speaker_forced: '🔊',
  wired_headphones: '🎧',
  wired_headset: '🎧',
  usb_headset: '🎧',
  hdmi: '📺',
  bluetooth_a2dp: '🎵',
  bluetooth_sco: '🎤',
};

interface AudioOutput {
  id: string;
  label: string;
  type: string;
}

interface AudioInfo {
  volume: number;          // 0–100
  volumeRaw: number;
  volumeMax: number;
  isMuted: boolean;
  currentOutput: string;
  availableOutputs: AudioOutput[];
}

interface Props {
  showWifi: boolean;
  showBluetooth: boolean;
  showAudio: boolean;
}

export default function LockscreenQuickPanel({ showWifi, showBluetooth, showAudio }: Props) {
  // ── panel open/close ──────────────────────────────────────────────────────
  const [isOpen, setIsOpen] = useState(false);
  const panelY = useRef(new Animated.Value(0)).current;

  // ── sub-dialogs ──────────────────────────────────────────────────────────
  const [wifiDialogVisible, setWifiDialogVisible] = useState(false);
  const [bluetoothDialogVisible, setBluetoothDialogVisible] = useState(false);
  const [outputPickerVisible, setOutputPickerVisible] = useState(false);

  // ── audio state ───────────────────────────────────────────────────────────
  const [audioInfo, setAudioInfo] = useState<AudioInfo | null>(null);
  const [localVolume, setLocalVolume] = useState(50); // optimistic while dragging
  const [isDraggingVolume, setIsDraggingVolume] = useState(false);

  const rowCount =
    (showWifi || showBluetooth ? 1 : 0) +
    (showAudio ? 1 : 0);
  const panelHeight = rowCount * ROW_HEIGHT;

  // ── animation helpers ─────────────────────────────────────────────────────
  const open = useCallback(() => {
    setIsOpen(true);
    Animated.spring(panelY, {
      toValue: panelHeight,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start();
  }, [panelY, panelHeight]);

  const close = useCallback(() => {
    Animated.spring(panelY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start(() => setIsOpen(false));
  }, [panelY]);

  // ── pan responder ─────────────────────────────────────────────────────────
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 5,
      onPanResponderMove: (_, gs) => {
        const clamped = Math.max(0, Math.min(panelHeight, gs.dy));
        panelY.setValue(clamped);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > DRAG_THRESHOLD) open();
        else if (gs.dy < -DRAG_THRESHOLD) close();
        else {
          Animated.spring(panelY, {
            toValue: isOpen ? panelHeight : 0,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  // ── audio refresh ─────────────────────────────────────────────────────────
  const refreshAudio = useCallback(async () => {
    if (!showAudio || !AudioControlModule) return;
    try {
      const info: AudioInfo = await AudioControlModule.getAudioInfo();
      setAudioInfo(info);
      if (!isDraggingVolume) setLocalVolume(info.volume);
    } catch (e) {
      console.warn('[LockscreenQuickPanel] getAudioInfo error:', e);
    }
  }, [showAudio, isDraggingVolume]);

  useEffect(() => {
    if (isOpen && showAudio) refreshAudio();
  }, [isOpen, showAudio, refreshAudio]);

  // Close panel when a full-screen dialog opens
  useEffect(() => {
    if (wifiDialogVisible || bluetoothDialogVisible) close();
  }, [wifiDialogVisible, bluetoothDialogVisible, close]);

  // ── audio handlers ────────────────────────────────────────────────────────
  const handleVolumeChange = (val: number) => {
    setLocalVolume(Math.round(val));
  };
  const handleVolumeComplete = async (val: number) => {
    setIsDraggingVolume(false);
    const pct = Math.round(val);
    setLocalVolume(pct);
    try {
      await AudioControlModule.setVolume(pct);
      await refreshAudio();
    } catch (e) {
      console.warn('[LockscreenQuickPanel] setVolume error:', e);
    }
  };
  const handleMuteToggle = async () => {
    if (!audioInfo) return;
    try {
      await AudioControlModule.setMuted(!audioInfo.isMuted);
      await refreshAudio();
    } catch (e) {
      console.warn('[LockscreenQuickPanel] setMuted error:', e);
    }
  };
  const handleSelectOutput = async (outputId: string) => {
    setOutputPickerVisible(false);
    try {
      await AudioControlModule.setAudioOutput(outputId);
      await refreshAudio();
    } catch (e) {
      console.warn('[LockscreenQuickPanel] setAudioOutput error:', e);
    }
  };

  if (rowCount === 0) return null;

  const currentOutputIcon = OUTPUT_ICONS[audioInfo?.currentOutput ?? 'speaker'] ?? '🔊';
  const isMuted = audioInfo?.isMuted ?? false;

  return (
    <>
      {/* ── Drag wrapper ──────────────────────────────────────────────────── */}
      <Animated.View
        style={[
          styles.panelWrapper,
          { transform: [{ translateY: panelY }] },
          { top: -panelHeight },   // sits above screen edge; panelY slides it into view
        ]}
        {...panResponder.panHandlers}
      >
        {/* Content rows */}
        <Animated.View
          style={[
            styles.panel,
            { height: panelHeight },
            {
              opacity: panelY.interpolate({
                inputRange: [0, panelHeight * 0.3, panelHeight],
                outputRange: [0, 0.5, 1],
              }),
            },
          ]}
          pointerEvents={isOpen ? 'auto' : 'none'}
        >
          {/* WiFi / BT row */}
          {(showWifi || showBluetooth) && (
            <View style={styles.row}>
              {showWifi && (
                <TouchableOpacity
                  style={styles.iconBtn}
                  onPress={() => setWifiDialogVisible(true)}
                >
                  <Text style={styles.iconBtnIcon}>📶</Text>
                  <Text style={styles.iconBtnLabel}>Wi-Fi</Text>
                </TouchableOpacity>
              )}
              {showBluetooth && (
                <TouchableOpacity
                  style={styles.iconBtn}
                  onPress={() => setBluetoothDialogVisible(true)}
                >
                  <Text style={styles.iconBtnIcon}>🔵</Text>
                  <Text style={styles.iconBtnLabel}>Bluetooth</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Audio row */}
          {showAudio && (
            <View style={[styles.row, styles.audioRow]}>
              {/* Output selector */}
              <TouchableOpacity
                style={styles.outputBtn}
                onPress={() => setOutputPickerVisible(true)}
              >
                <Text style={styles.outputIcon}>{currentOutputIcon}</Text>
              </TouchableOpacity>

              {/* Mute toggle */}
              <TouchableOpacity style={styles.muteBtn} onPress={handleMuteToggle}>
                <Text style={styles.muteIcon}>{isMuted ? '🔇' : '🔉'}</Text>
              </TouchableOpacity>

              {/* Volume slider */}
              <View style={styles.sliderWrap}>
                <Slider
                  style={styles.slider}
                  minimumValue={0}
                  maximumValue={100}
                  step={1}
                  value={localVolume}
                  onValueChange={handleVolumeChange}
                  onSlidingStart={() => setIsDraggingVolume(true)}
                  onSlidingComplete={handleVolumeComplete}
                  minimumTrackTintColor="#4fc3f7"
                  maximumTrackTintColor="rgba(255,255,255,0.25)"
                  thumbTintColor="#fff"
                />
                <Text style={styles.volLabel}>{localVolume}%</Text>
              </View>
            </View>
          )}
        </Animated.View>

        {/* Drag handle — always at the bottom of this wrapper so it sits at screen top */}
        <TouchableOpacity
          style={styles.handle}
          onPress={() => (isOpen ? close() : open())}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 0, right: 0 }}
        >
          <View style={styles.handleBar} />
        </TouchableOpacity>
      </Animated.View>

      {/* ── Full-screen dialogs ───────────────────────────────────────────── */}
      <WifiDialog visible={wifiDialogVisible} onClose={() => setWifiDialogVisible(false)} />
      <BluetoothDialog visible={bluetoothDialogVisible} onClose={() => setBluetoothDialogVisible(false)} />

      {/* ── Output picker (inline modal) ──────────────────────────────────── */}
      <Modal
        visible={outputPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setOutputPickerVisible(false)}
      >
        <TouchableOpacity
          style={styles.pickerOverlay}
          activeOpacity={1}
          onPress={() => setOutputPickerVisible(false)}
        >
          <View style={styles.pickerCard}>
            <Text style={styles.pickerTitle}>Audio Output</Text>
            {(audioInfo?.availableOutputs ?? []).map((out) => {
              const isActive = out.type === audioInfo?.currentOutput || out.id === audioInfo?.currentOutput;
              return (
                <TouchableOpacity
                  key={out.id}
                  style={[styles.pickerRow, isActive && styles.pickerRowActive]}
                  onPress={() => handleSelectOutput(out.id)}
                >
                  <Text style={styles.pickerRowIcon}>{OUTPUT_ICONS[out.type] ?? '🔈'}</Text>
                  <Text style={[styles.pickerRowLabel, isActive && styles.pickerRowLabelActive]}>
                    {out.label}
                  </Text>
                  {isActive && <Text style={styles.pickerCheck}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  panelWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 9000,
    flexDirection: 'column',
  },
  panel: {
    backgroundColor: 'rgba(18,18,18,0.94)',
    overflow: 'hidden',
  },
  handle: {
    height: HANDLE_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
  },
  handleBar: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.6)',
  },
  // ── rows
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
    gap: 12,
  },
  audioRow: {
    gap: 8,
  },
  // ── WiFi / BT buttons
  iconBtn: {
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    minWidth: 72,
  },
  iconBtnIcon: {
    fontSize: 24,
    marginBottom: 3,
  },
  iconBtnLabel: {
    fontSize: 11,
    color: '#ddd',
    fontWeight: '600',
  },
  // ── audio controls
  outputBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  outputIcon: {
    fontSize: 22,
  },
  muteBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  muteIcon: {
    fontSize: 22,
  },
  sliderWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  slider: {
    flex: 1,
    height: 40,
  },
  volLabel: {
    width: 36,
    fontSize: 12,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'right',
  },
  // ── output picker modal
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  pickerCard: {
    backgroundColor: '#1e1e1e',
    borderRadius: 14,
    width: '100%',
    maxWidth: 340,
    paddingVertical: 8,
    overflow: 'hidden',
  },
  pickerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.5)',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 14,
  },
  pickerRowActive: {
    backgroundColor: 'rgba(79,195,247,0.15)',
  },
  pickerRowIcon: {
    fontSize: 22,
  },
  pickerRowLabel: {
    flex: 1,
    fontSize: 16,
    color: '#ddd',
  },
  pickerRowLabelActive: {
    color: '#4fc3f7',
    fontWeight: '600',
  },
  pickerCheck: {
    fontSize: 18,
    color: '#4fc3f7',
    fontWeight: 'bold',
  },
});
