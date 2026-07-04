#!/usr/bin/env bash
# Remove GPU/GL libraries bundled into AppImages by linuxdeploy-plugin-gtk.
# Bundling these causes libglvnd loader/dispatch mismatches with host Mesa
# drivers (EGL_BAD_PARAMETER, blank WebView) on rolling distros like Arch.
set -euo pipefail

appimage="${1:?usage: strip-appimage-gpu-libs.sh <path-to.AppImage>}"
appimage="$(realpath "$appimage")"
arch_kernel="$(uname -m)"

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

pushd "$work" >/dev/null
"$appimage" --appimage-extract >/dev/null

find squashfs-root \( -type f -o -type l \) \( \
  -name 'libGL.so*' -o \
  -name 'libEGL.so*' -o \
  -name 'libGLX.so*' -o \
  -name 'libGLdispatch.so*' -o \
  -name 'libOpenGL.so*' -o \
  -name 'libgbm.so*' -o \
  -name 'libdrm.so*' -o \
  -name 'libepoxy.so*' -o \
  -name 'libwayland-client.so*' -o \
  -name 'libwayland-cursor.so*' -o \
  -name 'libwayland-egl.so*' -o \
  -name 'libwayland-server.so*' \
\) -delete

curl -fsSL --retry 3 -o appimagetool.AppImage \
  "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${arch_kernel}.AppImage"
chmod +x appimagetool.AppImage

rm -f "$appimage" "${appimage}.sig"
ARCH="$arch_kernel" ./appimagetool.AppImage --no-appstream squashfs-root "$appimage"
popd >/dev/null

echo "Repacked GPU-lib-free AppImage: $appimage"
