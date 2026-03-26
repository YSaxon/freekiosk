# Installation

## Recommended Paths

- Basic mode: quick setup, partial lockdown
- Device Owner mode: production setup, full lockdown

## Quick Install (Basic Mode)

1. Download latest APK from [Releases](https://github.com/rushb-fr/freekiosk/releases)
2. Install on Android 8.0+ tablet
3. Open settings (`5 taps + PIN`)
4. Configure URL and security options
5. Start kiosk mode

## Advanced Install (Device Owner Mode)

Use this for full security and unattended deployments.

Key points:

- Remove all accounts before activation
- Enable USB debugging
- Install app but do not configure yet
- Run:

```bash
adb shell dpm set-device-owner com.freekiosk/.DeviceAdminReceiver
```

Then configure app via UI or ADB provisioning.

## Full Guides

- [Full Installation Guide](../docs/INSTALL.md)
- [ADB Configuration Guide](../docs/ADB_CONFIG.md)
- [FAQ](../docs/FAQ.md)

## Troubleshooting Highlights

- `dpm` command fails: verify no active accounts on device
- Device unauthorized in ADB: accept debug prompt on tablet
- Partial lockdown: verify Device Owner activation
