import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  NativeModules,
} from 'react-native';
import { verifySecurePin, getLockoutStatus, hasSecurePin } from '../utils/secureStorage';
import { StorageService } from '../utils/storage';
import WifiDialog from './WifiDialog';
import BluetoothDialog from './BluetoothDialog';
import LockscreenQuickPanel from './LockscreenQuickPanel';

const { KioskModule } = NativeModules;

interface PinInputProps {
  onSuccess: () => void;
  storedPin: string; // Kept for backward compatibility but not used
}

const PinInput: React.FC<PinInputProps> = ({ onSuccess }) => {
  const [pin, setPin] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isLockedOut, setIsLockedOut] = useState<boolean>(false);
  const [lockoutTimeRemaining, setLockoutTimeRemaining] = useState<number>(0);
  const [attemptsRemaining, setAttemptsRemaining] = useState<number>(5);
  const [hasPinConfigured, setHasPinConfigured] = useState<boolean>(false);
  const [pinMode, setPinMode] = useState<'numeric' | 'alphanumeric'>('numeric');
  const inputRef = useRef<TextInput>(null);

  // Lock screen controls visibility
  const [showWifiButton, setShowWifiButton] = useState(false);
  const [showBluetoothButton, setShowBluetoothButton] = useState(false);
  const [showAudioControls, setShowAudioControls] = useState(false);
  const [showEmergencyButton, setShowEmergencyButton] = useState(false);

  // Dialog visibility
  const [wifiDialogVisible, setWifiDialogVisible] = useState(false);
  const [bluetoothDialogVisible, setBluetoothDialogVisible] = useState(false);

  useEffect(() => {
    checkLockoutStatus();
    checkPinConfiguration();
    loadPinMode();
    loadLockscreenSettings();
    const interval = setInterval(checkLockoutStatus, 1000);
    return () => {
      clearInterval(interval);
    };
  }, []);

  const loadLockscreenSettings = async (): Promise<void> => {
    const [wifi, bt, audio, emergency] = await Promise.all([
      StorageService.getLockscreenWifiEnabled(),
      StorageService.getLockscreenBluetoothEnabled(),
      StorageService.getLockscreenAudioEnabled(),
      StorageService.getLockscreenEmergencyCallEnabled(),
    ]);
    setShowWifiButton(wifi);
    setShowBluetoothButton(bt);
    setShowAudioControls(audio);
    setShowEmergencyButton(emergency);
  };

  const handlePinChange = (text: string): void => {
    if (pinMode === 'numeric') {
      const filtered = text.replace(/[^0-9]/g, '');
      setPin(filtered);
    } else {
      setPin(text);
    }
  };

  const loadPinMode = async (): Promise<void> => {
    const mode = await StorageService.getPinMode();
    setPinMode(mode);
  };

  const checkPinConfiguration = async (): Promise<void> => {
    const isPinConfigured = await hasSecurePin();
    setHasPinConfigured(isPinConfigured);
  };

  const checkLockoutStatus = async (): Promise<void> => {
    const status = await getLockoutStatus();
    setIsLockedOut(status.isLockedOut);
    setLockoutTimeRemaining(status.timeRemaining || 0);
    setAttemptsRemaining(status.attemptsRemaining);
  };

  const handleSubmit = async (): Promise<void> => {
    if (isLockedOut) {
      Alert.alert(
        '🔒 Locked Out',
        `Too many failed attempts.\n\nTry again in ${Math.ceil(lockoutTimeRemaining / 60000)} minutes.`
      );
      return;
    }

    if (pin.length < 4) {
      Alert.alert('Error', 'Password must be at least 4 characters');
      return;
    }

    setIsLoading(true);

    try {
      const result = await verifySecurePin(pin);

      if (result.success) {
        setPin('');
        onSuccess();
      } else {
        setPin('');

        if (result.lockoutTimeRemaining) {
          setIsLockedOut(true);
          setLockoutTimeRemaining(result.lockoutTimeRemaining);
          Alert.alert(
            '🔒 Too Many Failed Attempts',
            result.message || 'Account locked for 15 minutes',
            [{ text: 'OK' }]
          );
        } else {
          setAttemptsRemaining(result.attemptsRemaining || 0);
          Alert.alert(
            '❌ Incorrect PIN',
            `${result.attemptsRemaining || 0} attempts remaining`,
            [{ text: 'Try Again' }]
          );
        }
      }
    } catch (error) {
      console.error('[PinInput] Error verifying PIN:', error);
      Alert.alert('Error', 'An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmergencyCall = async (): Promise<void> => {
    try {
      await KioskModule.launchEmergencyDial();
    } catch (e) {
      console.warn('[PinInput] launchEmergencyDial error:', e);
      Alert.alert('Emergency Call', 'Unable to open the emergency dialer.');
    }
  };

  const formatTime = (milliseconds: number): string => {
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.floor((milliseconds % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const hasQuickControls = showWifiButton || showBluetoothButton || showEmergencyButton;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{pinMode === 'alphanumeric' ? 'Enter Password' : 'Enter PIN Code'}</Text>

      {isLockedOut ? (
        <>
          <View style={styles.lockoutContainer}>
            <Text style={styles.lockoutIcon}>🔒</Text>
            <Text style={styles.lockoutTitle}>Account Locked</Text>
            <Text style={styles.lockoutText}>
              Too many failed attempts
            </Text>
            <Text style={styles.lockoutTimer}>
              Retry in: {formatTime(lockoutTimeRemaining)}
            </Text>
          </View>
        </>
      ) : (
        <>
          {!hasPinConfigured && (
            <Text style={styles.subtitle}>Default code: 1234</Text>
          )}

          {attemptsRemaining < 5 && (
            <View style={styles.warningContainer}>
              <Text style={styles.warningText}>
                ⚠️ {attemptsRemaining} attempts remaining
              </Text>
            </View>
          )}

          <TextInput
            ref={inputRef}
            style={[styles.input, isLoading && styles.inputDisabled]}
            value={pin}
            onChangeText={handlePinChange}
            secureTextEntry={true}
            keyboardType={pinMode === 'alphanumeric' ? 'default' : 'numeric'}
            maxLength={pinMode === 'alphanumeric' ? undefined : 6}
            placeholder={pinMode === 'alphanumeric' ? 'Enter password' : '••••'}
            placeholderTextColor="#999999"
            autoFocus
            autoCapitalize={pinMode === 'alphanumeric' ? 'none' : undefined}
            autoCorrect={false}
            autoComplete="off"
            textContentType="none"
            importantForAutofill="no"
            editable={!isLoading && !isLockedOut}
          />

          <TouchableOpacity
            style={[styles.button, (isLoading || isLockedOut) && styles.buttonDisabled]}
            onPress={handleSubmit}
            disabled={isLoading || isLockedOut}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Validate</Text>
            )}
          </TouchableOpacity>
        </>
      )}

      {/* Quick controls row — only shown when at least one is enabled in settings */}
      {hasQuickControls && (
        <View style={styles.quickControls}>
          {showWifiButton && (
            <TouchableOpacity
              style={styles.quickBtn}
              onPress={() => setWifiDialogVisible(true)}
            >
              <Text style={styles.quickBtnIcon}>📶</Text>
              <Text style={styles.quickBtnLabel}>Wi-Fi</Text>
            </TouchableOpacity>
          )}

          {showBluetoothButton && (
            <TouchableOpacity
              style={styles.quickBtn}
              onPress={() => setBluetoothDialogVisible(true)}
            >
              <Text style={styles.quickBtnIcon}>🔵</Text>
              <Text style={styles.quickBtnLabel}>Bluetooth</Text>
            </TouchableOpacity>
          )}

          {showEmergencyButton && (
            <TouchableOpacity
              style={[styles.quickBtn, styles.emergencyBtn]}
              onPress={handleEmergencyCall}
            >
              <Text style={styles.quickBtnIcon}>🆘</Text>
              <Text style={[styles.quickBtnLabel, styles.emergencyLabel]}>Emergency</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Modals — rendered outside the card so they cover the full screen */}
      <WifiDialog
        visible={wifiDialogVisible}
        onClose={() => setWifiDialogVisible(false)}
      />
      <BluetoothDialog
        visible={bluetoothDialogVisible}
        onClose={() => setBluetoothDialogVisible(false)}
      />
      <LockscreenQuickPanel
        showWifi={false}
        showBluetooth={false}
        showAudio={showAudioControls}
        showEmergency={false}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#333',
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 30,
  },
  input: {
    width: '80%',
    height: 60,
    borderWidth: 2,
    borderColor: '#0066cc',
    borderRadius: 8,
    paddingHorizontal: 20,
    fontSize: 24,
    color: '#333333',
    backgroundColor: '#fff',
    marginBottom: 20,
    textAlign: 'center',
    letterSpacing: 10,
  },
  inputDisabled: {
    backgroundColor: '#e0e0e0',
    borderColor: '#999',
    opacity: 0.6,
  },
  button: {
    backgroundColor: '#0066cc',
    paddingHorizontal: 50,
    paddingVertical: 15,
    borderRadius: 8,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#999',
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  warningContainer: {
    backgroundColor: '#fff3cd',
    borderWidth: 1,
    borderColor: '#ffc107',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
    width: '80%',
  },
  warningText: {
    color: '#856404',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  lockoutContainer: {
    alignItems: 'center',
    padding: 30,
    backgroundColor: '#fff',
    borderRadius: 12,
    width: '80%',
    borderWidth: 2,
    borderColor: '#dc3545',
  },
  lockoutIcon: {
    fontSize: 64,
    marginBottom: 20,
  },
  lockoutTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#dc3545',
    marginBottom: 10,
  },
  lockoutText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 20,
    textAlign: 'center',
  },
  lockoutTimer: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#dc3545',
    fontFamily: 'monospace',
  },
  // Quick controls
  quickControls: {
    position: 'absolute',
    bottom: 32,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 20,
  },
  quickBtn: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    elevation: 3,
    minWidth: 80,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  quickBtnIcon: {
    fontSize: 28,
    marginBottom: 4,
  },
  quickBtnLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#444',
  },
  emergencyBtn: {
    borderColor: '#dc3545',
    borderWidth: 2,
  },
  emergencyLabel: {
    color: '#dc3545',
  },
});

export default PinInput;
