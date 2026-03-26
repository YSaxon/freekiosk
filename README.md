# FreeKiosk

Free open-source kiosk mode for Android tablets.

[Website](https://freekiosk.app) • [Releases](https://github.com/rushb-fr/freekiosk/releases) • [Issues](https://github.com/rushb-fr/freekiosk/issues)

## Overview

FreeKiosk is a free alternative to commercial kiosk apps with:

- Android `Device Owner` support for full lockdown
- WebView kiosk mode and External App mode
- Optional screen pinning and PIN/password protection
- Home Assistant integrations via REST API and MQTT
- Headless provisioning via ADB for mass deployments

## Quick Start

1. Download the latest APK from [Releases](https://github.com/rushb-fr/freekiosk/releases)
2. Install it on an Android 8.0+ tablet
3. Open app settings (5 taps + PIN)
4. Configure URL / mode, then start kiosk mode

For production deployments with complete lockdown, use Device Owner setup:

- [Installation Guide](docs/INSTALL.md#advanced-install-device-owner-mode)

## Documentation Hub

Detailed documentation has been moved into an organized wiki structure in `wiki/`.

- [Wiki Home](wiki/Home.md)
- [Installation](wiki/Installation.md)
- [Features & Modes](wiki/Features-and-Modes.md)
- [Integrations](wiki/Integrations.md)
- [Roadmap & Changelog](wiki/Roadmap-and-Changelog.md)
- [Development](wiki/Development.md)

## Technical Reference

- [Install Guide](docs/INSTALL.md)
- [ADB Configuration](docs/ADB_CONFIG.md)
- [REST API](docs/REST_API.md)
- [MQTT](docs/MQTT.md)
- [FAQ](docs/FAQ.md)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT License — see [LICENSE](LICENSE).
