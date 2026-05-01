#!/usr/bin/env bash
# setup-device.sh — Provision an Android device as a FreeKiosk kiosk.
#
# Works on macOS, Linux, and Windows (Git Bash / MSYS2 / WSL).
#
# Usage:
#   ./setup-device.sh [OPTIONS]
#
# Options:
#   --apk FILE        FreeKiosk APK to install (skipped if omitted)
#   --config FILE     FreeKiosk backup JSON to push to the device for import
#   --adb PATH        Path to adb binary (default: adb from $PATH)
#   --package PKG     FreeKiosk package name (default: com.freekiosk)
#   --admin COMP      Device admin component (default: com.freekiosk/.DeviceAdminReceiver)
#   -y / --yes        Auto-accept prompts (still asks before destructive steps)
#   -h / --help       Show this help and exit
#
# What the script does (in order):
#   1. Verify adb is reachable and wait for exactly one device
#   2. Print device model / Android version
#   3. [--apk] Install the APK — handling signature mismatches and existing
#      device-owner status along the way
#   4. Grant runtime permissions FreeKiosk needs (usage-stats, overlay,
#      WRITE_SECURE_SETTINGS, accessibility service)
#   5. Check for secondary Android users and signed-in accounts that would block
#      set-device-owner
#   6. Temporarily disable account-provider packages, set FreeKiosk as Device
#      Owner, then restore only packages this script disabled
#   7. [--config] Push the backup JSON to /sdcard/Download/ and print import
#      instructions
#   8. Disable removable OEM/system companion packages that widen the Settings
#      surface on some devices
#   9. Launch FreeKiosk

set -uo pipefail

# ── colours ────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'; YELLOW='\033[0;33m'; GREEN='\033[0;32m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
  RED=''; YELLOW=''; GREEN=''; CYAN=''; BOLD=''; RESET=''
fi

info()    { echo -e "${CYAN}[•]${RESET} $*"; }
ok()      { echo -e "${GREEN}[✓]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[!]${RESET} $*"; }
die()     { echo -e "${RED}[✗]${RESET} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}── $* ──${RESET}"; }
log()     { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >>"$LOG_FILE"; }

# ── defaults ───────────────────────────────────────────────────────────────────
ADB="adb"
PACKAGE="com.freekiosk"
ADMIN_COMPONENT="com.freekiosk/.DeviceAdminReceiver"
APK_PATH=""
CONFIG_PATH=""
AUTO_YES=false
LOG_ROOT="logs/FreeKiosk"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_ROOT/setup-$RUN_ID.log"
TEMP_DISABLED_PACKAGES=()
CLEANED_UP=false

mkdir -p "$LOG_ROOT"

# ── argument parsing ───────────────────────────────────────────────────────────
usage() {
  sed -n '2,/^set -/{ /^set -/d; s/^# \{0,2\}//; p }' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk)      APK_PATH="$2";        shift 2 ;;
    --config)   CONFIG_PATH="$2";     shift 2 ;;
    --adb)      ADB="$2";             shift 2 ;;
    --package)  PACKAGE="$2";         shift 2 ;;
    --admin)    ADMIN_COMPONENT="$2"; shift 2 ;;
    -y|--yes)   AUTO_YES=true;        shift   ;;
    -h|--help)  usage ;;
    *)          die "Unknown option: $1  (try --help)" ;;
  esac
done

# ── helpers ────────────────────────────────────────────────────────────────────

# Prompts the user with [y/N]. Returns 0 for yes, 1 for no.
# With -d flag: default is yes if AUTO_YES is set.
ask() {
  local prompt="$1" default="${2:-n}"
  if [[ "$default" == "y" && "$AUTO_YES" == "true" ]]; then
    echo -e "${YELLOW}[?]${RESET} $prompt ${YELLOW}[auto-yes]${RESET}"
    return 0
  fi
  local yn_hint
  [[ "$default" == "y" ]] && yn_hint="[Y/n]" || yn_hint="[y/N]"
  echo -en "${YELLOW}[?]${RESET} $prompt $yn_hint "
  read -r answer
  answer="${answer:-$default}"
  [[ "${answer,,}" == "y" ]]
}

# Same but always requires explicit confirmation (never auto-yes).
ask_destructive() {
  local prompt="$1"
  echo -en "${RED}[!]${RESET} $prompt [y/N] "
  read -r answer
  [[ "${answer,,}" == "y" ]]
}

adb_shell() { "$ADB" shell "$@" 2>/dev/null; }
adb_shell_check() { "$ADB" shell "$@"; }

adb_logged() {
  log "adb $*"
  "$ADB" "$@" >>"$LOG_FILE" 2>&1
}

pkg_installed() {
  adb_shell "pm list packages $1" | grep -q "^package:$1$"
}

pkg_disabled() {
  adb_shell "pm list packages -d $1" | grep -q "^package:$1$"
}

is_device_owner() {
  adb_shell "dumpsys device_policy" 2>/dev/null \
    | grep -q "mDeviceOwnerPackageName.*$PACKAGE"
}

account_count() {
  # Returns the number of signed-in accounts on the device
  local count
  count=$(adb_shell "dumpsys account" 2>/dev/null \
    | grep -c "Account {" || true)
  echo "${count:-0}"
}

user_count() {
  local count
  count=$(adb_shell "pm list users" | grep -c "UserInfo{" || true)
  echo "${count:-1}"
}

secondary_user_ids() {
  adb_shell "pm list users" \
    | sed -n 's/.*UserInfo{\([0-9][0-9]*\):.*/\1/p' \
    | grep -v '^0$' || true
}

account_provider_packages() {
  {
    adb_shell "dumpsys account" \
      | grep -oE '[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+/[A-Za-z0-9_.$]+' \
      | cut -d/ -f1
    printf '%s\n' \
      com.microsoft.office.officehubrow \
      com.microsoft.office.word \
      com.microsoft.office.excel \
      com.microsoft.office.outlook \
      com.microsoft.office.powerpoint
  } | sort -u | grep -v "^$PACKAGE$" || true
}

disable_temporarily() {
  local pkg="$1" label="${2:-$1}"

  if ! adb_shell "pm list packages $pkg" | grep -q "^package:$pkg$"; then
    info "$label ($pkg) not present — skipping."
    return 0
  fi

  if pkg_disabled "$pkg"; then
    info "$label ($pkg) already disabled — leaving it unchanged."
    return 0
  fi

  info "Temporarily disabling $label ($pkg)."
  if adb_logged shell pm disable-user --user 0 "$pkg"; then
    TEMP_DISABLED_PACKAGES+=("$pkg")
  else
    warn "Could not disable $label ($pkg); continuing."
  fi
}

restore_temp_disabled_packages() {
  [[ "$CLEANED_UP" == "true" ]] && return 0
  CLEANED_UP=true

  if [[ "${#TEMP_DISABLED_PACKAGES[@]}" -eq 0 ]]; then
    return 0
  fi

  header "Restoring Temporarily Disabled Packages"
  local pkg
  for pkg in "${TEMP_DISABLED_PACKAGES[@]}"; do
    info "Re-enabling $pkg"
    adb_logged shell pm enable "$pkg" || warn "Could not re-enable $pkg; check $LOG_FILE"
  done
}

trap restore_temp_disabled_packages EXIT

# ── step 1: adb + device ───────────────────────────────────────────────────────
header "Checking ADB"
info "Writing setup log to $LOG_FILE"
log "FreeKiosk setup started"

if ! command -v "$ADB" &>/dev/null; then
  die "adb not found at '$ADB'. Install Android platform-tools or pass --adb <path>."
fi
ok "adb found: $("$ADB" version | head -1)"

info "Starting adb server..."
adb_logged start-server || die "Could not start adb server. Check $LOG_FILE."

info "Waiting for exactly one device (connect via USB and allow debugging)..."
while true; do
  devices_out=$("$ADB" devices 2>/dev/null || true)
  log "$devices_out"
  device_count=$(echo "$devices_out" | awk 'NR>1 && /device$/{n++} END{print n+0}')
  unauthorized_count=$(echo "$devices_out" | awk 'NR>1 && /unauthorized$/{n++} END{print n+0}')
  offline_count=$(echo "$devices_out" | awk 'NR>1 && /offline$/{n++} END{print n+0}')
  if [[ "$device_count" -eq 1 ]]; then
    break
  elif [[ "$device_count" -gt 1 ]]; then
    warn "Multiple devices detected — disconnect extras and press Enter."
    read -r _
  elif [[ "$unauthorized_count" -gt 0 ]]; then
    warn "Device is connected but unauthorized. Accept the USB debugging prompt on the device."
    sleep 2
  elif [[ "$offline_count" -gt 0 ]]; then
    warn "Device is offline. Replug USB or toggle USB debugging if this does not clear."
    sleep 2
  else
    echo -n "."
    sleep 2
  fi
done
echo ""

# ── step 2: device info ────────────────────────────────────────────────────────
header "Device Info"
model=$(adb_shell "getprop ro.product.model")
android_ver=$(adb_shell "getprop ro.build.version.release")
sdk=$(adb_shell "getprop ro.build.version.sdk")
serial=$("$ADB" get-serialno 2>/dev/null)
ok "Model   : $model (serial: $serial)"
ok "Android : $android_ver (SDK $sdk)"

if [[ "${sdk:-0}" -lt 21 ]]; then
  die "Android SDK $sdk is below the minimum required (21)."
fi

# ── step 3: install APK ────────────────────────────────────────────────────────
if [[ -n "$APK_PATH" ]]; then
  header "Installing APK"

  [[ -f "$APK_PATH" ]] || die "APK not found: $APK_PATH"
  info "APK: $APK_PATH"

  # Play Protect can race or block local installs on some managed/OEM builds.
  # Disable only for this run and restore it in the EXIT trap.
  if [[ "${sdk:-0}" -ge 23 ]]; then
    disable_temporarily "com.android.vending" "Google Play Store"
  fi

  if pkg_installed "$PACKAGE"; then
    info "FreeKiosk ($PACKAGE) is already installed."

    # Try a straightforward upgrade first
    info "Attempting upgrade install..."
    install_out=$("$ADB" install -r "$APK_PATH" 2>&1)
    if echo "$install_out" | grep -q "Success"; then
      ok "Upgraded successfully."
    else
      warn "Upgrade failed: $install_out"

      if echo "$install_out" | grep -q "INSTALL_FAILED_UPDATE_INCOMPATIBLE"; then
        warn "Signature mismatch — the installed APK was signed with a different key."
        warn "To replace it we must uninstall first."

        # We need to remove device owner before we can uninstall
        if is_device_owner; then
          if ask_destructive "FreeKiosk is the current Device Owner. Remove device owner status so we can reinstall?"; then
            info "Removing device owner..."
            adb_shell_check "dpm remove-active-admin $ADMIN_COMPONENT" || true
            # On some devices / Android versions the above command doesn't work;
            # fall back to clearing the app (loses data but always works)
            if is_device_owner; then
              warn "dpm remove-active-admin didn't work — trying force-stop + clear..."
              adb_shell "am force-stop $PACKAGE" || true
            fi
          else
            die "Cannot replace APK without removing device owner. Aborting."
          fi
        fi

        echo ""
        warn "Uninstalling the existing app is required."
        warn "Option A: keep app data  (pm uninstall -k)  — settings/PIN are preserved"
        warn "Option B: full uninstall — all data is wiped (import backup afterwards)"
        echo -en "${YELLOW}[?]${RESET} Which option? [A/b] "
        read -r choice
        choice="${choice:-a}"

        if [[ "${choice,,}" == "b" ]]; then
          if ask_destructive "This will erase all FreeKiosk data. Are you sure?"; then
            info "Uninstalling (full)..."
            "$ADB" shell pm uninstall "$PACKAGE" || true
          else
            die "Aborting at user request."
          fi
        else
          info "Uninstalling (keeping data)..."
          "$ADB" shell pm uninstall -k "$PACKAGE" || true
          # Note: -k keeps the signature record, so a fresh install of a
          # differently-signed APK will still fail. If that happens, fall back.
        fi

        info "Installing APK..."
        install_out=$("$ADB" install "$APK_PATH" 2>&1)
        if echo "$install_out" | grep -q "INSTALL_FAILED_UPDATE_INCOMPATIBLE"; then
          # The -k path kept the sig record — do a full cleanup and retry
          warn "Signature record still cached after -k uninstall. Doing full uninstall..."
          if ask_destructive "All remaining FreeKiosk data will be erased. Continue?"; then
            "$ADB" shell pm uninstall "$PACKAGE" || true
            install_out=$("$ADB" install "$APK_PATH" 2>&1)
          else
            die "Aborting at user request."
          fi
        fi

        if echo "$install_out" | grep -q "Success"; then
          ok "Installed successfully."
        else
          die "Install failed: $install_out"
        fi

      else
        die "Install failed for an unexpected reason: $install_out"
      fi
    fi

  else
    info "FreeKiosk not currently installed — fresh install..."
    install_out=$("$ADB" install "$APK_PATH" 2>&1)
    if echo "$install_out" | grep -q "Success"; then
      ok "Installed successfully."
    else
      die "Install failed: $install_out"
    fi
  fi
else
  if pkg_installed "$PACKAGE"; then
    ok "FreeKiosk is already installed (no --apk provided, skipping install step)."
  else
    warn "FreeKiosk does not appear to be installed and no --apk was provided."
    warn "The remaining steps may fail. Pass --apk to install it."
  fi
fi

# ── step 4: permissions ────────────────────────────────────────────────────────
header "Granting Permissions"

grant_permission() {
  local label="$1" cmd="$2"
  if eval "$ADB shell $cmd" &>/dev/null; then
    ok "$label"
  else
    warn "$label — command returned an error (may already be set, continuing)"
  fi
}

grant_permission "Usage stats (foreground app detection)" \
  "appops set $PACKAGE android:get_usage_stats allow"

grant_permission "WRITE_SECURE_SETTINGS (immersive/accessibility toggle)" \
  "pm grant $PACKAGE android.permission.WRITE_SECURE_SETTINGS"

# Overlay permission — granting before device owner may silently fail on some
# Android versions. We grant it again after set-device-owner as well.
grant_permission "System alert window (overlay button)" \
  "appops set $PACKAGE android:system_alert_window allow"

# Enable the accessibility service — requires WRITE_SECURE_SETTINGS granted above
info "Enabling FreeKiosk accessibility service..."
current_a11y=$(adb_shell "settings get secure enabled_accessibility_services" || true)
if echo "$current_a11y" | grep -q "$PACKAGE"; then
  ok "Accessibility service already enabled."
else
  new_a11y="${current_a11y:+$current_a11y:}${PACKAGE}/.FreeKioskAccessibilityService"
  if "$ADB" shell settings put secure enabled_accessibility_services "$new_a11y" 2>/dev/null; then
    ok "Accessibility service enabled."
  else
    warn "Could not enable accessibility service automatically — you may need to do this manually in Settings → Accessibility."
  fi
fi

# ── step 5a: multiple users check ──────────────────────────────────────────────
header "Android User Check"

users=$(user_count)
if [[ "$users" -gt 1 ]]; then
  warn "Found $users Android users/profiles on the device."
  warn "Secondary users, Guest, Secure Folder, and Dual Apps profiles can block device-owner activation."
  echo ""
  adb_shell "pm list users" || true
  echo ""
  warn "Removing secondary users deletes data inside those profiles."

  if ask_destructive "Remove all secondary Android users now?"; then
    while read -r user_id; do
      [[ -z "$user_id" ]] && continue
      info "Removing user/profile $user_id"
      adb_logged shell pm remove-user "$user_id" || warn "Could not remove user/profile $user_id"
    done < <(secondary_user_ids)

    users=$(user_count)
    if [[ "$users" -gt 1 ]]; then
      warn "Still showing $users users/profiles. Remove remaining profiles manually, then rerun if device-owner activation fails."
    else
      ok "Only primary user remains."
    fi
  else
    warn "Leaving secondary users in place. Device-owner activation may fail."
  fi
else
  ok "Only primary Android user is present."
fi

# ── step 5b: account check ─────────────────────────────────────────────────────
header "Account Check"

acc_count=$(account_count)
if [[ "$acc_count" -gt 0 ]]; then
  warn "Found $acc_count signed-in account(s) on the device."
  warn "Android requires zero accounts before set-device-owner can succeed."
  echo ""
  adb_shell "dumpsys account" 2>/dev/null | grep -A2 "Account {" | head -40 || true
  echo ""
  warn "Please remove all accounts from the device:"
  warn "  Settings → Accounts (& Backup) → Manage Accounts → remove each one"
  warn ""
  warn "For Google accounts on Android 11+, go to:"
  warn "  Settings → Google → [account] → Remove account"
  warn ""

  # Open the accounts settings screen for the user
  info "Opening accounts screen on device..."
  adb_shell "am start -n 'com.android.settings/com.android.settings.Settings\$AccountDashboardActivity'" &>/dev/null || \
  adb_shell "am start -n 'com.android.settings/com.android.settings.Settings\$UserAndAccountDashboardActivity'" &>/dev/null || true

  echo -en "${YELLOW}[?]${RESET} Press Enter when all accounts have been removed..."
  read -r _

  acc_count=$(account_count)
  if [[ "$acc_count" -gt 0 ]]; then
    warn "Still showing $acc_count account(s). set-device-owner will likely fail."
    warn "You can continue and try again after removing accounts manually."
    if ! ask "Continue anyway?"; then
      die "Aborting at user request."
    fi
  else
    ok "No accounts remaining."
  fi
else
  ok "No accounts on device — good to go."
fi

header "Account Provider Workaround"

provider_packages=$(account_provider_packages)
if [[ -n "$provider_packages" ]]; then
  warn "Some Android builds keep account providers registered after accounts are removed."
  warn "Temporarily disabling provider apps can make device-owner activation more reliable."
  echo ""
  echo "$provider_packages" | sed 's/^/  • /'
  echo ""
  if ask "Temporarily disable these provider packages until setup exits?" "y"; then
    while read -r pkg; do
      [[ -z "$pkg" ]] && continue
      disable_temporarily "$pkg" "Account provider"
    done <<<"$provider_packages"
    sleep 3
  else
    warn "Skipping account-provider workaround."
  fi
else
  ok "No extra account-provider packages detected."
fi

# ── step 6: set device owner ───────────────────────────────────────────────────
header "Setting Device Owner"

if is_device_owner; then
  ok "FreeKiosk is already Device Owner — skipping."
else
  info "Running: dpm set-device-owner $ADMIN_COMPONENT"
  log "adb shell dpm set-device-owner $ADMIN_COMPONENT"
  dpm_out=$("$ADB" shell dpm set-device-owner "$ADMIN_COMPONENT" 2>&1)
  printf '%s\n' "$dpm_out" >>"$LOG_FILE"
  if echo "$dpm_out" | grep -q "Success"; then
    ok "Device owner set."
  else
    warn "set-device-owner failed:"
    echo "  $dpm_out"
    echo ""
    warn "Common causes:"
    warn "  • Accounts still present — remove them and re-run this script"
    warn "  • Another app is already device owner:"
    warn "    adb shell dumpsys device_policy | grep mDeviceOwnerPackageName"
    warn "  • Multiple users exist: adb shell pm list users"
    if ! ask "Continue without device owner? (kiosk locking won't work)"; then
      die "Aborting at user request."
    fi
  fi
fi

restore_temp_disabled_packages

# Re-grant overlay now that we (may) have device owner — this is more reliable post-DO
info "Re-granting overlay permission post device-owner..."
"$ADB" shell appops set "$PACKAGE" android:system_alert_window allow &>/dev/null || true

# ── step 7: push config ────────────────────────────────────────────────────────
if [[ -n "$CONFIG_PATH" ]]; then
  header "Pushing Config"
  [[ -f "$CONFIG_PATH" ]] || die "Config file not found: $CONFIG_PATH"

  dest_filename="freekiosk-restore.json"
  dest_path="/sdcard/Download/$dest_filename"

  info "Pushing $CONFIG_PATH → $dest_path"
  if "$ADB" push "$CONFIG_PATH" "$dest_path"; then
    ok "Config pushed."
    echo ""
    info "To restore settings inside FreeKiosk:"
    info "  1. Open FreeKiosk (or use: adb shell am start -n $PACKAGE/.MainActivity)"
    info "  2. Enter your PIN to reach Settings"
    info "  3. Scroll to the bottom → Import → pick $dest_filename"
    echo ""
  else
    warn "Push failed — you can copy the file manually to the device's Downloads folder."
  fi
fi

# ── step 8: prune removable OEM/settings companions ───────────────────────────
header "Removing Optional OEM Settings Companions"

remove_user0_package() {
  local pkg="$1" label="$2"
  if ! adb_shell "pm list packages $pkg" | grep -q "^package:$pkg$"; then
    info "$label ($pkg) not present — skipping."
    return
  fi

  info "Trying to uninstall $label for user 0: $pkg"
  local out
  out=$("$ADB" shell pm uninstall --user 0 "$pkg" 2>&1 || true)
  if echo "$out" | grep -q "Success"; then
    ok "$label removed for user 0."
  else
    warn "$label could not be removed automatically: $out"
  fi
}

# Motorola Help is a known second-hop surface reachable from Settings on some
# Motorola devices. Settings Intelligence powers the Settings search surface.
# Removing them for user 0 narrows what a student can reach from Settings while
# preserving the base Settings app.
remove_user0_package "com.motorola.help" "Moto Help"
remove_user0_package "com.android.settings.intelligence" "Settings Intelligence"

# ── step 9: launch ─────────────────────────────────────────────────────────────
header "Launching FreeKiosk"

if pkg_installed "$PACKAGE"; then
  if ask "Launch FreeKiosk now?" "y"; then
    "$ADB" shell am start -n "$PACKAGE/.MainActivity" &>/dev/null
    ok "FreeKiosk launched."
  fi
else
  warn "Package $PACKAGE not found on device — cannot launch."
fi

# ── done ───────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Setup complete.${RESET}"
if [[ -n "$CONFIG_PATH" ]]; then
  echo -e "  Import your backup from: ${BOLD}/sdcard/Download/freekiosk-restore.json${RESET}"
fi
echo ""
