package com.freekiosk

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.ScanResult
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class WifiControlModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var scanReceiver: BroadcastReceiver? = null
    override fun getName(): String = "WifiControlModule"

    override fun onCatalystInstanceDestroy() {
        unregisterScanReceiver()
    }

    // ─── State ────────────────────────────────────────────────────────────────

    @ReactMethod
    fun getWifiInfo(promise: Promise) {
        try {
            val wifiManager = reactContext.applicationContext
                .getSystemService(Context.WIFI_SERVICE) as WifiManager
            val connectivityManager = reactContext
                .getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

            val result = Arguments.createMap()
            val isEnabled = wifiManager.isWifiEnabled
            result.putBoolean("isEnabled", isEnabled)

            val isConnected = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val net = connectivityManager.activeNetwork
                val caps = connectivityManager.getNetworkCapabilities(net)
                caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            } else {
                @Suppress("DEPRECATION")
                connectivityManager.getNetworkInfo(ConnectivityManager.TYPE_WIFI)?.isConnected == true
            }
            result.putBoolean("isConnected", isConnected)

            if (isConnected) {
                @Suppress("DEPRECATION")
                val info = wifiManager.connectionInfo
                val ssid = info.ssid?.replace("\"", "")?.trim() ?: ""
                result.putString("ssid", ssid)
                result.putInt("signalLevel", WifiManager.calculateSignalLevel(info.rssi, 5))
                result.putInt("rssi", info.rssi)
            } else {
                result.putString("ssid", "")
                result.putInt("signalLevel", 0)
                result.putInt("rssi", 0)
            }

            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("WIFI_ERROR", e.message, e)
        }
    }

    // ─── Toggle ───────────────────────────────────────────────────────────────

    @ReactMethod
    fun setWifiEnabled(enabled: Boolean, promise: Promise) {
        try {
            val wifiManager = reactContext.applicationContext
                .getSystemService(Context.WIFI_SERVICE) as WifiManager

            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                // Pre-Android 10: direct toggle works fine
                @Suppress("DEPRECATION")
                val success = wifiManager.setWifiEnabled(enabled)
                val result = Arguments.createMap()
                result.putBoolean("success", success)
                result.putBoolean("requiresSystemPanel", false)
                promise.resolve(result)
            } else {
                // Android 10+: setWifiEnabled() is blocked for non-system apps.
                // We return requiresSystemPanel=true so the JS layer can open the
                // Settings.Panel.ACTION_WIFI overlay via openSystemWifiPanel().
                val result = Arguments.createMap()
                result.putBoolean("success", false)
                result.putBoolean("requiresSystemPanel", true)
                promise.resolve(result)
            }
        } catch (e: Exception) {
            promise.reject("WIFI_TOGGLE_ERROR", e.message, e)
        }
    }

    // Opens the Android 10+ WiFi settings panel as a bottom-sheet overlay.
    // This is the only safe way to let users toggle WiFi on Android 10+ without
    // giving access to all of Settings.
    @ReactMethod
    fun openSystemWifiPanel(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val intent = Intent(Settings.Panel.ACTION_WIFI).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(intent)
                promise.resolve(true)
            } else {
                // Pre-10: open the WiFi-only settings page (not all of Settings)
                val intent = Intent(Settings.ACTION_WIFI_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(intent)
                promise.resolve(true)
            }
        } catch (e: Exception) {
            promise.reject("WIFI_PANEL_ERROR", e.message, e)
        }
    }

    // ─── Scan ─────────────────────────────────────────────────────────────────

    @ReactMethod
    fun startScan(promise: Promise) {
        try {
            val wifiManager = reactContext.applicationContext
                .getSystemService(Context.WIFI_SERVICE) as WifiManager

            if (!wifiManager.isWifiEnabled) {
                promise.reject("WIFI_DISABLED", "WiFi is disabled")
                return
            }

            unregisterScanReceiver()

            scanReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    unregisterScanReceiver()
                    val results = buildScanResults(wifiManager)
                    sendEvent("wifiScanResults", results)
                }
            }

            reactContext.registerReceiver(
                scanReceiver,
                IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)
            )

            @Suppress("DEPRECATION")
            val started = wifiManager.startScan()
            promise.resolve(started)
        } catch (e: Exception) {
            promise.reject("SCAN_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getScanResults(promise: Promise) {
        try {
            val wifiManager = reactContext.applicationContext
                .getSystemService(Context.WIFI_SERVICE) as WifiManager
            promise.resolve(buildScanResults(wifiManager))
        } catch (e: Exception) {
            promise.reject("SCAN_RESULTS_ERROR", e.message, e)
        }
    }

    private fun buildScanResults(wifiManager: WifiManager): WritableArray {
        val arr = Arguments.createArray()
        val hasLocation = ContextCompat.checkSelfPermission(
            reactContext, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasLocation) return arr

        val seen = mutableSetOf<String>()
        val raw: List<ScanResult> = try {
            @Suppress("DEPRECATION")
            wifiManager.scanResults ?: emptyList()
        } catch (e: SecurityException) {
            emptyList()
        }

        // Sort by signal level descending
        raw.sortedByDescending { it.level }.forEach { sr ->
            val ssid = sr.SSID?.trim() ?: ""
            if (ssid.isEmpty() || !seen.add(ssid)) return@forEach

            val net = Arguments.createMap()
            net.putString("ssid", ssid)
            net.putString("bssid", sr.BSSID ?: "")
            net.putInt("signalLevel", WifiManager.calculateSignalLevel(sr.level, 5))
            net.putInt("rssi", sr.level)
            val secured = sr.capabilities?.let {
                it.contains("WPA") || it.contains("WEP") || it.contains("PSK")
            } ?: false
            net.putBoolean("secured", secured)
            net.putString("capabilities", sr.capabilities ?: "")
            arr.pushMap(net)
        }
        return arr
    }

    // ─── Connect ──────────────────────────────────────────────────────────────

    @ReactMethod
    fun connectToNetwork(ssid: String, password: String, promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                connectApi29(ssid, password, promise)
            } else {
                @Suppress("DEPRECATION")
                connectLegacy(ssid, password, promise)
            }
        } catch (e: Exception) {
            promise.reject("CONNECT_ERROR", e.message, e)
        }
    }

    // Android 10+ (API 29+): WifiNetworkSuggestion establishes a full
    // internet-providing system-wide Wi-Fi connection (unlike WifiNetworkSpecifier
    // which only binds the requesting process to a peer/local network).
    @Suppress("NewApi")
    private fun connectApi29(ssid: String, password: String, promise: Promise) {
        val wifiManager = reactContext.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as WifiManager

        val suggestionBuilder = WifiNetworkSuggestion.Builder().setSsid(ssid)
        if (password.isNotEmpty()) {
            suggestionBuilder.setWpa2Passphrase(password)
        }
        val suggestion = suggestionBuilder.build()

        // Remove any stale suggestion for this SSID before adding the new one
        wifiManager.removeNetworkSuggestions(listOf(suggestion))
        val status = wifiManager.addNetworkSuggestions(listOf(suggestion))

        if (status == WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS ||
            status == WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_ADD_DUPLICATE) {
            // Trigger a scan so the system finds and connects to the network quickly
            wifiManager.startScan()
            val result = Arguments.createMap()
            result.putBoolean("success", true)
            result.putString("ssid", ssid)
            promise.resolve(result)
        } else {
            promise.reject("CONNECT_ERROR", "addNetworkSuggestions failed: status=$status")
        }
    }

    // Pre-Android 10: Use the (deprecated) WifiConfiguration approach which
    // does not require a system dialog and works silently.
    @Suppress("DEPRECATION")
    private fun connectLegacy(ssid: String, password: String, promise: Promise) {
        val wifiManager = reactContext.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as WifiManager

        val config = WifiConfiguration().apply {
            SSID = "\"$ssid\""
            if (password.isEmpty()) {
                allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
            } else {
                preSharedKey = "\"$password\""
            }
        }

        val netId = wifiManager.addNetwork(config)
        if (netId == -1) {
            promise.reject("ADD_NETWORK_FAILED", "Failed to add network configuration for $ssid")
            return
        }

        wifiManager.disconnect()
        val enabled = wifiManager.enableNetwork(netId, true)
        wifiManager.reconnect()

        val result = Arguments.createMap()
        result.putBoolean("success", enabled)
        result.putString("ssid", ssid)
        promise.resolve(result)
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private fun sendEvent(eventName: String, params: Any?) {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (e: Exception) {
            // JS bridge may not be ready yet
        }
    }

    private fun unregisterScanReceiver() {
        scanReceiver?.let {
            try { reactContext.unregisterReceiver(it) } catch (_: Exception) {}
            scanReceiver = null
        }
    }

    // Required for addListener / removeListeners to suppress RN warnings
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
