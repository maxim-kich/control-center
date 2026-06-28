#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
APP_NAME="Control Center"
APP_PATH="${ROOT}/${APP_NAME}.app"
CONTENTS_DIR="${APP_PATH}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
ICONSET_DIR="${RESOURCES_DIR}/AppIcon.iconset"

rm -rf "$APP_PATH"
chmod +x "${ROOT}/scripts/launch_macos_app.sh"

if ! command -v osacompile >/dev/null 2>&1; then
  echo "error: osacompile is required to build the macOS app launcher" >&2
  exit 1
fi

APPLESCRIPT_ROOT="${ROOT//\\/\\\\}"
APPLESCRIPT_ROOT="${APPLESCRIPT_ROOT//\"/\\\"}"
APPLESCRIPT_FILE="$(mktemp)"
cat > "$APPLESCRIPT_FILE" <<APPLESCRIPT
set projectRoot to "${APPLESCRIPT_ROOT}"
set launcherScript to projectRoot & "/scripts/launch_macos_app.sh"
set envPrefix to "CC_DASHBOARD_ROOT=" & quoted form of projectRoot & " "
repeat with envName in {"PORT", "CONTROL_CENTER_HOME", "CC_DB_PATH", "CC_CODEX_BIN", "CC_GRAPHIFY_ENABLED", "CC_GRAPHIFY_WATCH"}
  set envValue to system attribute envName
  if envValue is not "" then set envPrefix to envPrefix & envName & "=" & quoted form of envValue & " "
end repeat
do shell script envPrefix & quoted form of launcherScript & " >/dev/null 2>&1 &"
APPLESCRIPT
/usr/bin/osacompile -o "$APP_PATH" "$APPLESCRIPT_FILE"
rm -f "$APPLESCRIPT_FILE"

/usr/bin/plutil -replace CFBundleDisplayName -string "$APP_NAME" "${CONTENTS_DIR}/Info.plist"
/usr/bin/plutil -replace CFBundleIconFile -string "AppIcon" "${CONTENTS_DIR}/Info.plist"
/usr/bin/plutil -replace CFBundleIdentifier -string "local.control-center.launcher" "${CONTENTS_DIR}/Info.plist"
/usr/bin/plutil -replace CFBundleName -string "$APP_NAME" "${CONTENTS_DIR}/Info.plist"
/usr/bin/plutil -replace CFBundleShortVersionString -string "1.0" "${CONTENTS_DIR}/Info.plist"
/usr/bin/plutil -replace CFBundleVersion -string "1" "${CONTENTS_DIR}/Info.plist"
/usr/bin/plutil -replace LSMinimumSystemVersion -string "10.13" "${CONTENTS_DIR}/Info.plist"
/usr/bin/plutil -replace NSHighResolutionCapable -bool YES "${CONTENTS_DIR}/Info.plist"
for key in \
  CFBundleIconName \
  NSAppleEventsUsageDescription \
  NSAppleMusicUsageDescription \
  NSCalendarsUsageDescription \
  NSCameraUsageDescription \
  NSContactsUsageDescription \
  NSHomeKitUsageDescription \
  NSMicrophoneUsageDescription \
  NSPhotoLibraryUsageDescription \
  NSRemindersUsageDescription \
  NSSiriUsageDescription \
  NSSystemAdministrationUsageDescription; do
  /usr/bin/plutil -remove "$key" "${CONTENTS_DIR}/Info.plist" 2>/dev/null || true
done

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cat > "${RESOURCES_DIR}/AppIcon.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="164" y1="112" x2="860" y2="912" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fb923c"/>
      <stop offset="0.48" stop-color="#ea580c"/>
      <stop offset="1" stop-color="#7c2d12"/>
    </linearGradient>
    <linearGradient id="screen" x1="205" y1="250" x2="819" y2="770" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1c1917"/>
      <stop offset="1" stop-color="#292524"/>
    </linearGradient>
    <linearGradient id="accent" x1="292" y1="424" x2="714" y2="632" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fed7aa"/>
      <stop offset="1" stop-color="#fdba74"/>
    </linearGradient>
  </defs>
  <rect x="92" y="92" width="840" height="840" rx="190" fill="url(#bg)"/>
  <rect x="172" y="238" width="680" height="548" rx="74" fill="url(#screen)" opacity="0.96"/>
  <circle cx="250" cy="312" r="24" fill="#fecaca"/>
  <circle cx="322" cy="312" r="24" fill="#fed7aa"/>
  <circle cx="394" cy="312" r="24" fill="#fde68a"/>
  <path d="M314 510L438 420" fill="none" stroke="url(#accent)" stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M314 510L438 600" fill="none" stroke="url(#accent)" stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M506 626H710" fill="none" stroke="#fff7ed" stroke-width="56" stroke-linecap="round"/>
  <rect x="226" y="700" width="572" height="22" rx="11" fill="#fdba74" opacity="0.36"/>
</svg>
SVG

mkdir -p "${ROOT}/public"
cp "${RESOURCES_DIR}/AppIcon.svg" "${ROOT}/public/notification-icon.svg"

if command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  rm -rf "$ICONSET_DIR"
  mkdir -p "$ICONSET_DIR"

  /usr/bin/sips -s format png -z 512 512 "${RESOURCES_DIR}/AppIcon.svg" --out "${ROOT}/public/notification-icon.png" >/dev/null
  /usr/bin/sips -s format png -z 16 16 "${RESOURCES_DIR}/AppIcon.svg" --out "${ICONSET_DIR}/icon_16x16.png" >/dev/null
  /usr/bin/sips -s format png -z 32 32 "${RESOURCES_DIR}/AppIcon.svg" --out "${ICONSET_DIR}/icon_16x16@2x.png" >/dev/null
  /usr/bin/sips -s format png -z 32 32 "${RESOURCES_DIR}/AppIcon.svg" --out "${ICONSET_DIR}/icon_32x32.png" >/dev/null
  /usr/bin/sips -s format png -z 64 64 "${RESOURCES_DIR}/AppIcon.svg" --out "${ICONSET_DIR}/icon_32x32@2x.png" >/dev/null
  /usr/bin/sips -s format png -z 128 128 "${RESOURCES_DIR}/AppIcon.svg" --out "${ICONSET_DIR}/icon_128x128.png" >/dev/null
  /usr/bin/sips -s format png -z 256 256 "${RESOURCES_DIR}/AppIcon.svg" --out "${ICONSET_DIR}/icon_128x128@2x.png" >/dev/null
  /usr/bin/sips -s format png -z 256 256 "${RESOURCES_DIR}/AppIcon.svg" --out "${ICONSET_DIR}/icon_256x256.png" >/dev/null
  /usr/bin/sips -s format png -z 512 512 "${RESOURCES_DIR}/AppIcon.svg" --out "${ICONSET_DIR}/icon_256x256@2x.png" >/dev/null
  /usr/bin/sips -s format png -z 512 512 "${RESOURCES_DIR}/AppIcon.svg" --out "${ICONSET_DIR}/icon_512x512.png" >/dev/null
  /usr/bin/sips -s format png -z 1024 1024 "${RESOURCES_DIR}/AppIcon.svg" --out "${ICONSET_DIR}/icon_512x512@2x.png" >/dev/null
  /usr/bin/iconutil -c icns "$ICONSET_DIR" -o "${RESOURCES_DIR}/AppIcon.icns"
  rm -rf "$ICONSET_DIR"
fi

/usr/bin/touch "$APP_PATH"
if command -v codesign >/dev/null 2>&1; then
  /usr/bin/codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 || true
fi
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$APP_PATH" >/dev/null 2>&1 || true
fi
printf 'Created %s\n' "$APP_PATH"
