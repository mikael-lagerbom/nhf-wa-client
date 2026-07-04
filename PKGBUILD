# Local build: export PUBLIC_EXTERNAL_API_HOST (or rely on default), then: makepkg -si
pkgname=nhf-addon-manager
pkgver=0.5.7
pkgrel=1
pkgdesc="NHF WeakAuras / addon manager (Tauri), built against host webkit"
arch=('x86_64')
url="https://github.com/sragia/nhf-wa-client"
license=('MIT')
depends=('webkit2gtk-4.1' 'libayatana-appindicator' 'gtk3' 'hicolor-icon-theme')
makedepends=('rust' 'cargo' 'npm' 'nodejs' 'binutils')
options=('!strip' '!lto')

build() {
  cd "$startdir"

  export PUBLIC_EXTERNAL_API_HOST="${PUBLIC_EXTERNAL_API_HOST:-https://nhfguild.com}"

  # Arch's rust defaults to rust-lld, which can fail to link ring/zstd symbols.
  export RUSTFLAGS="${RUSTFLAGS:-} -C linker=gcc -C link-arg=-fuse-ld=bfd"

  npm install
  npm run tauri build -- --no-bundle
}

package() {
  cd "$startdir"

  install -Dm755 "src-tauri/target/release/nhf-aura-manager" \
    "$pkgdir/usr/bin/$pkgname"
  install -Dm644 "src-tauri/icons/128x128.png" \
    "$pkgdir/usr/share/icons/hicolor/128x128/apps/$pkgname.png"

  install -Dm644 /dev/stdin "$pkgdir/usr/share/applications/$pkgname.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=NHF Addon Manager
Exec=$pkgname
Icon=$pkgname
Categories=Utility;
Terminal=false
EOF
}
