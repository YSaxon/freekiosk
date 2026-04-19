package com.freekiosk

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.modules.core.DeviceEventManagerModule

class BluetoothControlModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var discoveryReceiver: BroadcastReceiver? = null

    override fun getName(): String = "BluetoothControlModule"

    override fun onCatalystInstanceDestroy() {
        unregisterDiscoveryReceiver()
    }

    private fun getAdapter(): BluetoothAdapter? {
        val manager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        return manager?.adapter
    }

    // ─── State ────────────────────────────────────────────────────────────────

    @ReactMethod
    fun getBluetoothInfo(promise: Promise) {
        try {
            val adapter = getAdapter()
            val result = Arguments.createMap()

            if (adapter == null) {
                result.putBoolean("supported", false)
                result.putBoolean("isEnabled", false)
                result.putArray("bondedDevices", Arguments.createArray())
                promise.resolve(result)
                return
            }

            result.putBoolean("supported", true)
            result.putBoolean("isEnabled", adapter.isEnabled)
            result.putArray("bondedDevices", buildBondedDevices(adapter))
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("BT_ERROR", e.message, e)
        }
    }

    private fun buildBondedDevices(adapter: BluetoothAdapter): WritableArray {
        val arr = Arguments.createArray()
        val hasPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(
                reactContext, Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED
        } else true

        if (!hasPermission) return arr

        try {
            adapter.bondedDevices?.forEach { device ->
                val map = Arguments.createMap()
                map.putString("address", device.address)
                map.putString("name", device.name ?: device.address)
                map.putInt("type", device.type)

                // Check if currently connected via reflection (hidden API)
                val connected = try {
                    val method = device.javaClass.getMethod("isConnected")
                    method.invoke(device) as? Boolean ?: false
                } catch (_: Exception) { false }

                map.putBoolean("connected", connected)
                arr.pushMap(map)
            }
        } catch (_: SecurityException) {}
        return arr
    }

    // ─── Toggle ───────────────────────────────────────────────────────────────

    @ReactMethod
    fun setBluetoothEnabled(enabled: Boolean, promise: Promise) {
        try {
            val adapter = getAdapter()
            if (adapter == null) {
                promise.reject("BT_NOT_SUPPORTED", "Bluetooth not supported on this device")
                return
            }

            // BLUETOOTH_CONNECT permission required on Android 12+ (API 31+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val granted = ContextCompat.checkSelfPermission(
                    reactContext, Manifest.permission.BLUETOOTH_CONNECT
                ) == PackageManager.PERMISSION_GRANTED
                if (!granted) {
                    promise.reject("PERMISSION_DENIED", "BLUETOOTH_CONNECT permission not granted")
                    return
                }
            }

            val result = Arguments.createMap()
            if (enabled) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    // Android 13+: enable() is deprecated but still functional when
                    // BLUETOOTH_CONNECT permission is granted (which we have).
                    @Suppress("DEPRECATION")
                    val ok = adapter.enable()
                    result.putBoolean("success", ok)
                    result.putBoolean("requiresSystemPanel", !ok)
                } else {
                    @Suppress("DEPRECATION")
                    result.putBoolean("success", adapter.enable())
                    result.putBoolean("requiresSystemPanel", false)
                }
            } else {
                @Suppress("DEPRECATION")
                result.putBoolean("success", adapter.disable())
                result.putBoolean("requiresSystemPanel", false)
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("BT_TOGGLE_ERROR", e.message, e)
        }
    }

    // Opens the Bluetooth settings panel (bottom-sheet on API 29+).
    @ReactMethod
    fun openSystemBluetoothPanel(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val intent = Intent(Settings.Panel.ACTION_BLUETOOTH).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(intent)
                promise.resolve(true)
            } else {
                val intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(intent)
                promise.resolve(true)
            }
        } catch (e: Exception) {
            promise.reject("BT_PANEL_ERROR", e.message, e)
        }
    }

    // ─── Discovery ────────────────────────────────────────────────────────────

    @ReactMethod
    fun startDiscovery(promise: Promise) {
        try {
            val adapter = getAdapter()
            if (adapter == null || !adapter.isEnabled) {
                promise.reject("BT_NOT_READY", "Bluetooth is not enabled")
                return
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val granted = ContextCompat.checkSelfPermission(
                    reactContext, Manifest.permission.BLUETOOTH_SCAN
                ) == PackageManager.PERMISSION_GRANTED
                if (!granted) {
                    promise.reject("PERMISSION_DENIED", "BLUETOOTH_SCAN permission not granted")
                    return
                }
            }

            unregisterDiscoveryReceiver()

            discoveryReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    when (intent.action) {
                        BluetoothDevice.ACTION_FOUND -> {
                            val device = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                            } else {
                                @Suppress("DEPRECATION")
                                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                            } ?: return

                            val rssi = intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE).toInt()
                            val map = Arguments.createMap()
                            map.putString("address", device.address)
                            map.putString("name", try { device.name ?: device.address } catch (_: SecurityException) { device.address })
                            map.putInt("rssi", rssi)
                            map.putBoolean("bonded", device.bondState == BluetoothDevice.BOND_BONDED)
                            sendEvent("bluetoothDeviceFound", map)
                        }
                        BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
                            unregisterDiscoveryReceiver()
                            sendEvent("bluetoothDiscoveryFinished", null)
                        }
                    }
                }
            }

            val filter = IntentFilter().apply {
                addAction(BluetoothDevice.ACTION_FOUND)
                addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
            }
            reactContext.registerReceiver(discoveryReceiver, filter)

            if (adapter.isDiscovering) adapter.cancelDiscovery()
            val started = adapter.startDiscovery()
            promise.resolve(started)
        } catch (e: Exception) {
            promise.reject("DISCOVERY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopDiscovery(promise: Promise) {
        try {
            unregisterDiscoveryReceiver()
            getAdapter()?.cancelDiscovery()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("STOP_DISCOVERY_ERROR", e.message, e)
        }
    }

    // ─── Pairing ──────────────────────────────────────────────────────────────

    @ReactMethod
    fun pairDevice(address: String, promise: Promise) {
        try {
            val adapter = getAdapter() ?: run {
                promise.reject("BT_NOT_SUPPORTED", "Bluetooth not supported")
                return
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val granted = ContextCompat.checkSelfPermission(
                    reactContext, Manifest.permission.BLUETOOTH_CONNECT
                ) == PackageManager.PERMISSION_GRANTED
                if (!granted) {
                    promise.reject("PERMISSION_DENIED", "BLUETOOTH_CONNECT permission not granted")
                    return
                }
            }

            val device = adapter.getRemoteDevice(address) ?: run {
                promise.reject("DEVICE_NOT_FOUND", "No device with address $address")
                return
            }

            if (device.bondState == BluetoothDevice.BOND_BONDED) {
                val result = Arguments.createMap()
                result.putBoolean("success", true)
                result.putBoolean("alreadyBonded", true)
                promise.resolve(result)
                return
            }

            // Listen for bond state changes
            val bondReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    if (intent.action != BluetoothDevice.ACTION_BOND_STATE_CHANGED) return
                    val changedDevice = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                    }
                    if (changedDevice?.address != address) return

                    val bondState = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE)
                    if (bondState == BluetoothDevice.BOND_BONDED) {
                        try { reactContext.unregisterReceiver(this) } catch (_: Exception) {}
                        val result = Arguments.createMap()
                        result.putBoolean("success", true)
                        result.putBoolean("alreadyBonded", false)
                        promise.resolve(result)
                    } else if (bondState == BluetoothDevice.BOND_NONE) {
                        try { reactContext.unregisterReceiver(this) } catch (_: Exception) {}
                        promise.reject("PAIRING_FAILED", "Pairing failed or was rejected")
                    }
                }
            }
            reactContext.registerReceiver(bondReceiver, IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED))

            val initiated = device.createBond()
            if (!initiated) {
                try { reactContext.unregisterReceiver(bondReceiver) } catch (_: Exception) {}
                promise.reject("BOND_INITIATION_FAILED", "Could not initiate pairing with $address")
            }
        } catch (e: Exception) {
            promise.reject("PAIR_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun unpairDevice(address: String, promise: Promise) {
        try {
            val adapter = getAdapter() ?: run {
                promise.reject("BT_NOT_SUPPORTED", "Bluetooth not supported")
                return
            }
            val device = adapter.getRemoteDevice(address) ?: run {
                promise.reject("DEVICE_NOT_FOUND", "No device with address $address")
                return
            }
            // removeBond is a hidden API, accessed via reflection
            val method = device.javaClass.getMethod("removeBond")
            val result = method.invoke(device) as? Boolean ?: false
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("UNPAIR_ERROR", e.message, e)
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private fun sendEvent(eventName: String, params: Any?) {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (_: Exception) {}
    }

    private fun unregisterDiscoveryReceiver() {
        discoveryReceiver?.let {
            try {
                getAdapter()?.cancelDiscovery()
                reactContext.unregisterReceiver(it)
            } catch (_: Exception) {}
            discoveryReceiver = null
        }
    }

    // Required to suppress RN native module warnings
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
