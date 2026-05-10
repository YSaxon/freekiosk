package com.freekiosk

import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.os.Build

/**
 * Re-arm kiosk mode after FreeKiosk itself is replaced.
 *
 * Android exits lock task mode during package replacement. If an external app stays
 * in front, MainActivity will not resume and therefore cannot call startLockTask()
 * again. This receiver is delivered after our own APK update/reinstall and brings
 * up BootLockActivity to immediately re-enter lock task.
 */
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return

        DebugLog.d(TAG, "Package replaced")

        if (!isKioskEnabled(context)) {
            DebugLog.d(TAG, "Kiosk mode disabled; not re-arming after package replace")
            return
        }

        startWatchdog(context)

        try {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            if (dpm.isDeviceOwnerApp(context.packageName)) {
                BootReceiver.updateDeBootFlag(context, true)
                val lockIntent = Intent(context, BootLockActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    putExtra("from_package_replaced", true)
                }
                context.startActivity(lockIntent)
                DebugLog.d(TAG, "Started BootLockActivity after package replace")
            } else {
                val mainIntent = Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    putExtra("from_package_replaced", true)
                }
                context.startActivity(mainIntent)
                DebugLog.d(TAG, "Started MainActivity after package replace")
            }
        } catch (e: Exception) {
            DebugLog.errorProduction(TAG, "Failed to re-arm after package replace: ${e.message}")
        }
    }

    private fun startWatchdog(context: Context) {
        try {
            val serviceIntent = Intent(context, KioskWatchdogService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
            DebugLog.d(TAG, "KioskWatchdogService started after package replace")
        } catch (e: Exception) {
            DebugLog.errorProduction(TAG, "Failed to start watchdog after package replace: ${e.message}")
        }
    }

    private fun isKioskEnabled(context: Context): Boolean {
        return try {
            val dbPath = context.getDatabasePath("RKStorage").absolutePath
            val db = SQLiteDatabase.openDatabase(dbPath, null, SQLiteDatabase.OPEN_READONLY)
            val cursor = db.rawQuery(
                "SELECT value FROM catalystLocalStorage WHERE key = ?",
                arrayOf("@kiosk_enabled")
            )
            val enabled = if (cursor.moveToFirst()) cursor.getString(0) == "true" else false
            cursor.close()
            db.close()
            enabled
        } catch (e: Exception) {
            DebugLog.d(TAG, "Cannot read kiosk_enabled: ${e.message}")
            false
        }
    }

    companion object {
        private const val TAG = "PackageReplacedReceiver"
    }
}
