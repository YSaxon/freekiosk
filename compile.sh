#!/usr/bin/env bash
# compile.sh — Build a release APK for FreeKiosk and optionally install it.
#
# Usage:
#   ./compile.sh [--install] [--java PATH] [--debug] [--clean] [--no-daemon]
#
# Options:
#   --install     Install the APK after building (adb must be in PATH)
#   --java PATH   Path to JDK home (auto-detected from known locations if omitted)
#   --debug       Build a debug APK instead of release
#   --clean       Run Gradle clean before building
#   --no-daemon   Disable the Gradle daemon for this build
#   -h / --help   Show this help

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$SCRIPT_DIR/android"

# ── colours ────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'
  RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; CYAN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
fi
info() { echo -e "${CYAN}[•]${RESET} $*"; }
ok()   { echo -e "${GREEN}[✓]${RESET} $*"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*"; }
die()  { echo -e "${RED}[✗]${RESET} $*" >&2; exit 1; }

# ── args ───────────────────────────────────────────────────────────────────────
DO_INSTALL=false
JAVA_HOME_OVERRIDE=""
BUILD_TYPE="release"
DO_CLEAN=false
USE_DAEMON=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)  DO_INSTALL=true;             shift ;;
    --java)     JAVA_HOME_OVERRIDE="$2";     shift 2 ;;
    --debug)    BUILD_TYPE="debug";          shift ;;
    --clean)    DO_CLEAN=true;               shift ;;
    --no-daemon) USE_DAEMON=false;           shift ;;
    -h|--help)
      sed -n '2,/^set -/{ /^set -/d; s/^# \{0,2\}//; p }' "$0"
      exit 0 ;;
    *)          die "Unknown option: $1  (try --help)" ;;
  esac
done

# ── find a compatible JDK (Java 17 or 21 preferred; Java 25 breaks Gradle 8) ──
find_java() {
  # Well-known locations on Windows/Mac/Linux
  local candidates=(
    # Windows — scoop (versioned path first, then current symlink)
    "$HOME/scoop/apps/temurin21-jdk/21.0.10-7.0"
    "$HOME/scoop/apps/temurin21-jdk/current"
    "$HOME/scoop/apps/temurin17-jdk/current"
    "$HOME/scoop/apps/openjdk21/current"
    # Mac — homebrew
    "/opt/homebrew/opt/openjdk@21"
    "/opt/homebrew/opt/openjdk@17"
    "/usr/local/opt/openjdk@21"
    "/usr/local/opt/openjdk@17"
    # Linux — common paths
    "/usr/lib/jvm/java-21-openjdk-amd64"
    "/usr/lib/jvm/java-17-openjdk-amd64"
    "/usr/lib/jvm/temurin-21"
    "/usr/lib/jvm/temurin-17"
    # Android Studio bundled JBR (Mac)
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    # Android Studio bundled JBR (Linux)
    "$HOME/android-studio/jbr"
  )
  for c in "${candidates[@]}"; do
    if [[ -x "$c/bin/java" ]]; then
      # Accept Java 17–23 (Gradle 8 supports up to 23)
      local ver
      ver=$("$c/bin/java" -version 2>&1 | grep -oE '"[0-9]+' | head -1 | tr -d '"')
      if [[ "${ver:-0}" -ge 17 && "${ver:-0}" -le 23 ]]; then
        echo "$c"
        return 0
      fi
    fi
  done

  # Also search scoop versioned subdirs (e.g. temurin21-jdk/21.0.10-7.0/bin/java)
  local scoop_base="$HOME/scoop/apps"
  if [[ -d "$scoop_base" ]]; then
    while IFS= read -r java_bin; do
      local c ver
      c="$(dirname "$(dirname "$java_bin")")"
      ver=$("$java_bin" -version 2>&1 | grep -oE '"[0-9]+' | head -1 | tr -d '"')
      if [[ "${ver:-0}" -ge 17 && "${ver:-0}" -le 23 ]]; then
        echo "$c"
        return 0
      fi
    done < <(find "$scoop_base" -maxdepth 4 \( -name "java.exe" -o -name "java" \) 2>/dev/null | sort)
  fi

  return 1
}

# ── locate JDK ─────────────────────────────────────────────────────────────────
if [[ -n "$JAVA_HOME_OVERRIDE" ]]; then
  export JAVA_HOME="$JAVA_HOME_OVERRIDE"
  info "Using JDK from --java: $JAVA_HOME"
elif [[ -n "${JAVA_HOME:-}" ]]; then
  # Check that the current JAVA_HOME is a supported version
  current_ver=$("$JAVA_HOME/bin/java" -version 2>&1 | grep -oE '"[0-9]+' | head -1 | tr -d '"')
  if [[ "${current_ver:-0}" -lt 17 || "${current_ver:-0}" -gt 23 ]]; then
    warn "JAVA_HOME points to Java $current_ver which is unsupported by Gradle 8 (need 17–23). Auto-detecting..."
    if jdk=$(find_java); then
      export JAVA_HOME="$jdk"
      ok "Found compatible JDK: $JAVA_HOME"
    else
      die "No compatible JDK (17–23) found. Install Temurin 21 or pass --java <path>."
    fi
  else
    info "Using JAVA_HOME=$JAVA_HOME (Java $current_ver)"
  fi
else
  if jdk=$(find_java); then
    export JAVA_HOME="$jdk"
    ok "Auto-detected JDK: $JAVA_HOME"
  else
    die "No compatible JDK (17–23) found. Install Temurin 21 or pass --java <path>."
  fi
fi
export PATH="$JAVA_HOME/bin:$PATH"

# ── ensure node_modules exist ──────────────────────────────────────────────────
if [[ ! -d "$SCRIPT_DIR/node_modules/@react-native" ]]; then
  info "node_modules missing — running npm install..."
  (cd "$SCRIPT_DIR" && npm install) || die "npm install failed"
  ok "npm install complete"
fi

# ── ensure local.properties has sdk.dir ────────────────────────────────────────
LOCAL_PROPS="$ANDROID_DIR/local.properties"
if [[ ! -f "$LOCAL_PROPS" ]] || ! grep -q "^sdk.dir" "$LOCAL_PROPS"; then
  # Auto-detect Android SDK
  SDK_CANDIDATES=(
    "${ANDROID_HOME:-}"
    "${ANDROID_SDK_ROOT:-}"
    "$HOME/AppData/Local/Android/Sdk"           # Windows
    "$HOME/Library/Android/sdk"                 # Mac
    "$HOME/Android/Sdk"                         # Linux
  )
  SDK_DIR=""
  for c in "${SDK_CANDIDATES[@]}"; do
    if [[ -n "$c" && -d "$c/platform-tools" ]]; then
      SDK_DIR="$c"
      break
    fi
  done
  [[ -n "$SDK_DIR" ]] || die "Android SDK not found. Set ANDROID_HOME or add sdk.dir to android/local.properties."

  # Gradle running on Windows does not understand Git Bash/MSYS paths like
  # /c/Users/... in local.properties. Convert them to native Windows paths.
  SDK_PROPS_DIR="$SDK_DIR"
  if command -v cygpath >/dev/null 2>&1; then
    SDK_PROPS_DIR="$(cygpath -w "$SDK_DIR" 2>/dev/null || echo "$SDK_DIR")"
  fi

  # local.properties needs escaped backslashes on Windows
  sdk_escaped="${SDK_PROPS_DIR//\\/\\\\}"
  # Also escape the colon for Windows paths (C: → C\:)
  sdk_escaped="${sdk_escaped/:/\\:}"
  echo "sdk.dir=$sdk_escaped" > "$LOCAL_PROPS"
  ok "Created local.properties: sdk.dir=$SDK_PROPS_DIR"
fi

# ── gradle.properties: ensure enough heap ─────────────────────────────────────
GRADLE_PROPS="$ANDROID_DIR/gradle.properties"
if [[ ! -f "$GRADLE_PROPS" ]] || ! grep -q "org.gradle.jvmargs" "$GRADLE_PROPS"; then
  cat >> "$GRADLE_PROPS" <<'EOF'
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=512m
org.gradle.daemon=true
org.gradle.parallel=true
EOF
  ok "Added JVM memory settings to gradle.properties"
fi

# ── build ──────────────────────────────────────────────────────────────────────
GRADLE_TASK="assemble$(tr '[:lower:]' '[:upper:]' <<< "${BUILD_TYPE:0:1}")${BUILD_TYPE:1}"
info "Building: $GRADLE_TASK"
echo ""

cd "$ANDROID_DIR"
GRADLE_ARGS=()
if [[ "$DO_CLEAN" == "true" ]]; then
  GRADLE_ARGS+=("clean")
fi
GRADLE_ARGS+=("$GRADLE_TASK")
if [[ "$USE_DAEMON" != "true" ]]; then
  GRADLE_ARGS+=("--no-daemon")
fi

./gradlew "${GRADLE_ARGS[@]}" 2>&1
BUILD_EXIT=$?

echo ""
if [[ $BUILD_EXIT -ne 0 ]]; then
  die "Gradle build failed (exit $BUILD_EXIT)"
fi

# ── locate APK ─────────────────────────────────────────────────────────────────
APK=$(find "$ANDROID_DIR/app/build/outputs/apk/$BUILD_TYPE" -name "*.apk" 2>/dev/null | head -1)
[[ -n "$APK" ]] || die "APK not found after build — check Gradle output above."
ok "Built: $APK"

# ── install ────────────────────────────────────────────────────────────────────
if [[ "$DO_INSTALL" == "true" ]]; then
  echo ""
  info "Installing on connected device..."
  if ! command -v adb &>/dev/null; then
    die "adb not found in PATH — add Android platform-tools to your PATH or install manually."
  fi
  if adb install -r "$APK" 2>&1; then
    ok "Installed successfully."
  else
    warn "Direct install failed (possibly signature mismatch)."
    warn "Run setup-device.sh --apk \"$APK\" for full provisioning including signature handling."
  fi
fi

echo ""
echo -e "${GREEN}${BOLD}Done.${RESET}  APK: ${BOLD}$APK${RESET}"
