package com.freekiosk

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class AudioControlModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AudioControlModule"

    private var preferredOutput: String = "auto"

    private fun audioManager(): AudioManager =
        reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    // ─── State snapshot ───────────────────────────────────────────────────────

    @ReactMethod
    fun getAudioInfo(promise: Promise) {
        try {
            val am = audioManager()
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)

            val isMuted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.isStreamMute(AudioManager.STREAM_MUSIC)
            } else {
                cur == 0
            }

            val result = Arguments.createMap()
            result.putInt("volume", if (max > 0) (cur * 100 / max) else 0)
            result.putInt("volumeRaw", cur)
            result.putInt("volumeMax", max)
            result.putBoolean("isMuted", isMuted)
            result.putString("currentOutput", describeCurrentOutput(am))
            result.putArray("availableOutputs", buildOutputList(am))
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("AUDIO_ERROR", e.message, e)
        }
    }

    // ─── Volume ───────────────────────────────────────────────────────────────

    @ReactMethod
    fun setVolume(percent: Int, promise: Promise) {
        try {
            val am = audioManager()
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            val target = (percent.coerceIn(0, 100) * max / 100)
            am.setStreamVolume(
                AudioManager.STREAM_MUSIC,
                target,
                0 // no UI flag — we're showing our own
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("VOLUME_ERROR", e.message, e)
        }
    }

    // ─── Mute ─────────────────────────────────────────────────────────────────

    @ReactMethod
    fun setMuted(muted: Boolean, promise: Promise) {
        try {
            val am = audioManager()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.adjustStreamVolume(
                    AudioManager.STREAM_MUSIC,
                    if (muted) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE,
                    0
                )
            } else {
                // Pre-M: set volume to 0 or restore
                @Suppress("DEPRECATION")
                am.setStreamMute(AudioManager.STREAM_MUSIC, muted)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("MUTE_ERROR", e.message, e)
        }
    }

    // ─── Output routing ───────────────────────────────────────────────────────

    /**
     * Route media audio to the selected output.
     *
     * Android does not expose a simple "route media to device X" API for
     * third-party apps; the proper routing is done by the system based on
     * connected peripherals.  What we CAN reliably do:
     *
     *  • "speaker"  → Force built-in speaker even when headphones/BT are
     *                 connected.  Uses MODE_IN_COMMUNICATION + setSpeakerphoneOn.
     *                 Works on the vast majority of devices.
     *  • "auto"     → Let the system choose (BT A2DP > wired > speaker).
     *  • "bluetooth"→ Trigger Bluetooth SCO (mono headset audio).
     *                 A2DP (stereo) is already active when the BT device is
     *                 connected and cannot be further routed by us.
     *
     * On API 31+, setCommunicationDevice is used instead where applicable.
     */
    @ReactMethod
    fun setAudioOutput(outputType: String, promise: Promise) {
        try {
            val am = audioManager()
            when (outputType) {
                "speaker" -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        // Find built-in speaker via AudioDeviceInfo
                        val speaker = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                            .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                        if (speaker != null) {
                            am.setCommunicationDevice(speaker)
                        }
                    }
                    // Also apply legacy path for full-stack coverage
                    am.stopBluetoothSco()
                    am.isBluetoothScoOn = false
                    am.mode = AudioManager.MODE_IN_COMMUNICATION
                    am.isSpeakerphoneOn = true
                    preferredOutput = "speaker"
                    promise.resolve(true)
                }
                "auto" -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        am.clearCommunicationDevice()
                    }
                    am.stopBluetoothSco()
                    am.isBluetoothScoOn = false
                    am.isSpeakerphoneOn = false
                    am.mode = AudioManager.MODE_NORMAL
                    preferredOutput = "auto"
                    promise.resolve(true)
                }
                "bluetooth_sco" -> {
                    am.mode = AudioManager.MODE_IN_COMMUNICATION
                    am.isSpeakerphoneOn = false
                    am.startBluetoothSco()
                    am.isBluetoothScoOn = true
                    preferredOutput = "bluetooth_sco"
                    promise.resolve(true)
                }
                "bluetooth_a2dp",
                "wired_headphones",
                "wired_headset",
                "usb_headset",
                "hdmi" -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        am.clearCommunicationDevice()
                    }
                    am.stopBluetoothSco()
                    am.isBluetoothScoOn = false
                    am.isSpeakerphoneOn = false
                    am.mode = AudioManager.MODE_NORMAL
                    preferredOutput = outputType
                    promise.resolve(true)
                }
                else -> {
                    // Unknown type — fall back to auto
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        am.clearCommunicationDevice()
                    }
                    am.stopBluetoothSco()
                    am.isBluetoothScoOn = false
                    am.isSpeakerphoneOn = false
                    am.mode = AudioManager.MODE_NORMAL
                    preferredOutput = "auto"
                    promise.resolve(true)
                }
            }
        } catch (e: Exception) {
            promise.reject("ROUTING_ERROR", e.message, e)
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private fun describeCurrentOutput(am: AudioManager): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val outputs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            if (preferredOutput == "speaker" && isUsingSpeaker(am)) return "speaker"
            if (preferredOutput == "bluetooth_sco" && am.isBluetoothScoOn) return "bluetooth_sco"
            if (preferredOutput != "auto" && outputs.any { outputTypeForDevice(it) == preferredOutput }) {
                return preferredOutput
            }

            // Priority: BT A2DP > wired headset/headphones > USB > speaker
            return when {
                outputs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP } -> "bluetooth_a2dp"
                outputs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO } && am.isBluetoothScoOn -> "bluetooth_sco"
                outputs.any { it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES } -> "wired_headphones"
                outputs.any { it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET } -> "wired_headset"
                outputs.any { it.type == AudioDeviceInfo.TYPE_USB_HEADSET } -> "usb_headset"
                outputs.any { it.type == AudioDeviceInfo.TYPE_HDMI } -> "hdmi"
                am.isSpeakerphoneOn -> "speaker"
                else -> "speaker"
            }
        }
        // Pre-M fallback
        @Suppress("DEPRECATION")
        return when {
            am.isBluetoothA2dpOn -> "bluetooth_a2dp"
            am.isBluetoothScoOn -> "bluetooth_sco"
            am.isWiredHeadsetOn -> "wired_headset"
            am.isSpeakerphoneOn -> "speaker_forced"
            else -> "speaker"
        }
    }

    private fun isUsingSpeaker(am: AudioManager): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER || am.isSpeakerphoneOn
        } else {
            am.isSpeakerphoneOn
        }
    }

    private fun outputTypeForDevice(device: AudioDeviceInfo): String? {
        return when (device.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth_a2dp"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth_sco"
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired_headphones"
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired_headset"
            AudioDeviceInfo.TYPE_USB_HEADSET -> "usb_headset"
            AudioDeviceInfo.TYPE_HDMI -> "hdmi"
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
            else -> null
        }
    }

    private fun buildOutputList(am: AudioManager): WritableArray {
        val arr = Arguments.createArray()

        // Always include "auto" (let system decide) and built-in speaker
        arr.pushMap(makeOutput("auto", "System Default", "auto"))
        arr.pushMap(makeOutput("speaker", "Speaker", "speaker"))

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val outputs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            if (outputs.any { it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES }) {
                arr.pushMap(makeOutput("wired_headphones", "Wired Headphones", "wired_headphones"))
            }
            if (outputs.any { it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET }) {
                arr.pushMap(makeOutput("wired_headset", "Wired Headset", "wired_headset"))
            }
            if (outputs.any { it.type == AudioDeviceInfo.TYPE_USB_HEADSET }) {
                arr.pushMap(makeOutput("usb_headset", "USB Headset", "usb_headset"))
            }
            if (outputs.any { it.type == AudioDeviceInfo.TYPE_HDMI }) {
                arr.pushMap(makeOutput("hdmi", "HDMI / Display", "hdmi"))
            }
            // BT A2DP entries — one per connected device
            outputs
                .filter { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP }
                .forEach { dev ->
                    val name = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) dev.productName?.toString() else null
                    arr.pushMap(makeOutput(
                        "bluetooth_a2dp",
                        name ?: "Bluetooth (A2DP)",
                        "bluetooth_a2dp"
                    ))
                }
            outputs
                .filter { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
                .forEach { dev ->
                    val name = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) dev.productName?.toString() else null
                    arr.pushMap(makeOutput(
                        "bluetooth_sco",
                        name ?: "Bluetooth Headset",
                        "bluetooth_sco"
                    ))
                }
        } else {
            // Pre-M: detect via legacy APIs
            @Suppress("DEPRECATION")
            if (am.isBluetoothA2dpOn) {
                arr.pushMap(makeOutput("bluetooth_a2dp", "Bluetooth (A2DP)", "bluetooth_a2dp"))
            }
            @Suppress("DEPRECATION")
            if (am.isWiredHeadsetOn) {
                arr.pushMap(makeOutput("wired_headset", "Wired Headset", "wired_headset"))
            }
        }

        return arr
    }

    private fun makeOutput(id: String, label: String, type: String): WritableMap {
        val m = Arguments.createMap()
        m.putString("id", id)
        m.putString("label", label)
        m.putString("type", type)
        return m
    }

    private fun sendEvent(name: String, params: Any?) {
        try {
            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        } catch (_: Exception) {}
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
