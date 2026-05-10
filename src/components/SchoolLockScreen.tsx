import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { getLockoutStatus, hasSecurePin, verifySecurePin } from '../utils/secureStorage';
import { StorageService } from '../utils/storage';

interface SchoolLockScreenProps {
  currentSsid?: string;
  onUnlocked: () => void;
}

const SchoolLockScreen: React.FC<SchoolLockScreenProps> = ({ currentSsid, onUnlocked }) => {
  const [pin, setPin] = useState('');
  const [pinMode, setPinMode] = useState<'numeric' | 'alphanumeric'>('numeric');
  const [hasPinConfigured, setHasPinConfigured] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLockedOut, setIsLockedOut] = useState(false);
  const [lockoutTimeRemaining, setLockoutTimeRemaining] = useState(0);
  const [attemptsRemaining, setAttemptsRemaining] = useState(5);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    const load = async () => {
      setPinMode(await StorageService.getPinMode());
      setHasPinConfigured(await hasSecurePin());
      await checkLockoutStatus();
    };
    load().catch(error => console.warn('[SchoolLockScreen] Initial PIN state load failed:', error));
    const interval = setInterval(checkLockoutStatus, 1000);
    return () => clearInterval(interval);
  }, []);

  const checkLockoutStatus = async (): Promise<void> => {
    const status = await getLockoutStatus();
    setIsLockedOut(status.isLockedOut);
    setLockoutTimeRemaining(status.timeRemaining || 0);
    setAttemptsRemaining(status.attemptsRemaining);
  };

  const handlePinChange = (text: string): void => {
    setPin(pinMode === 'numeric' ? text.replace(/[^0-9]/g, '') : text);
  };

  const handleSubmit = async (): Promise<void> => {
    if (isLockedOut) {
      Alert.alert('Locked Out', `Too many failed attempts. Try again in ${Math.ceil(lockoutTimeRemaining / 60000)} minutes.`);
      return;
    }

    if (pin.length < 4) {
      Alert.alert('Error', 'Password must be at least 4 characters');
      return;
    }

    setIsLoading(true);
    try {
      const result = await verifySecurePin(pin);
      setPin('');
      if (result.success) {
        onUnlocked();
        return;
      }

      if (result.lockoutTimeRemaining) {
        setIsLockedOut(true);
        setLockoutTimeRemaining(result.lockoutTimeRemaining);
        Alert.alert('Too Many Failed Attempts', result.message || 'Account locked for 15 minutes');
      } else {
        setAttemptsRemaining(result.attemptsRemaining || 0);
        Alert.alert('Incorrect PIN', `${result.attemptsRemaining || 0} attempts remaining`);
      }
    } catch (error) {
      console.error('[SchoolLockScreen] Error verifying PIN:', error);
      Alert.alert('Error', 'An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const formatTime = (milliseconds: number): string => {
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.floor((milliseconds % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <View style={styles.container}>
      <View style={styles.logoCircle}>
        <Text style={styles.logoText}>FK</Text>
      </View>
      <Text style={styles.title}>FreeKiosk Locked</Text>
      <Text style={styles.subtitle}>
        School lock is active{currentSsid ? ` near ${currentSsid}` : ''}.
      </Text>

      {!hasPinConfigured && (
        <Text style={styles.defaultPinText}>Default code: 1234</Text>
      )}

      {isLockedOut ? (
        <View style={styles.lockoutContainer}>
          <Text style={styles.lockoutTitle}>Account Locked</Text>
          <Text style={styles.lockoutTimer}>Retry in: {formatTime(lockoutTimeRemaining)}</Text>
        </View>
      ) : (
        <>
          {attemptsRemaining < 5 && (
            <Text style={styles.warningText}>{attemptsRemaining} attempts remaining</Text>
          )}

          <TextInput
            ref={inputRef}
            style={[styles.input, isLoading && styles.inputDisabled]}
            value={pin}
            onChangeText={handlePinChange}
            secureTextEntry
            keyboardType={pinMode === 'alphanumeric' ? 'default' : 'numeric'}
            maxLength={pinMode === 'alphanumeric' ? undefined : 6}
            placeholder={pinMode === 'alphanumeric' ? 'Enter password' : 'PIN'}
            placeholderTextColor="#8a99aa"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            textContentType="none"
            importantForAutofill="no"
            editable={!isLoading}
          />

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={handleSubmit}
            disabled={isLoading}
          >
            {isLoading ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Unlock</Text>}
          </TouchableOpacity>
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#101820',
    padding: 28,
  },
  logoCircle: {
    width: 82,
    height: 82,
    borderRadius: 41,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2f80ed',
    marginBottom: 24,
  },
  logoText: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '800',
  },
  title: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    color: '#b8c7d9',
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 26,
  },
  defaultPinText: {
    color: '#d6e7ff',
    fontSize: 14,
    marginBottom: 14,
  },
  input: {
    width: '100%',
    maxWidth: 320,
    minHeight: 58,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4f6f91',
    backgroundColor: '#ffffff',
    color: '#17212b',
    fontSize: 22,
    paddingHorizontal: 18,
    textAlign: 'center',
    marginBottom: 16,
  },
  inputDisabled: {
    opacity: 0.6,
  },
  button: {
    width: '100%',
    maxWidth: 320,
    minHeight: 52,
    borderRadius: 8,
    backgroundColor: '#2f80ed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#607d9b',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  warningText: {
    color: '#ffd166',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 12,
  },
  lockoutContainer: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ff6b6b',
    backgroundColor: '#1f2b36',
    padding: 20,
    alignItems: 'center',
  },
  lockoutTitle: {
    color: '#ffb3b3',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 12,
  },
  lockoutTimer: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '800',
  },
});

export default SchoolLockScreen;
