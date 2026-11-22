#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 SMLIGHT
# Builds the release N-API addon into zerostack_adapter.<platform-tag>.node and verifies it exports
# only napi_register_module_v1.
#   CARGO_BUILD_TARGET  target triple; a glibc floor suffix (x86_64-unknown-linux-gnu.2.28) needs zigbuild
#   CARGO_SUBCOMMAND    cargo subcommand that builds (default build; zigbuild for cargo-zigbuild)
#   NM                  symbol lister for Linux and macOS outputs (default nm)
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
    triple=${CARGO_BUILD_TARGET%%.2.*}
else
    triple=$(rustc -vV | tr -d '\r' | awk '/^host:/ {print $2}')
fi
case "$triple" in
    x86_64-unknown-linux-gnu) tag=linux-x64-gnu ;;
    aarch64-unknown-linux-gnu) tag=linux-arm64-gnu ;;
    x86_64-unknown-linux-musl) tag=linux-x64-musl ;;
    aarch64-unknown-linux-musl) tag=linux-arm64-musl ;;
    armv7-unknown-linux-gnueabihf) tag=linux-arm-gnueabihf ;;
    armv7-unknown-linux-musleabihf) tag=linux-arm-musleabihf ;;
    riscv64gc-unknown-linux-gnu) tag=linux-riscv64-gnu ;;
    aarch64-apple-darwin) tag=darwin-arm64 ;;
    x86_64-apple-darwin) tag=darwin-x64 ;;
    x86_64-pc-windows-msvc) tag=win32-x64-msvc ;;
    aarch64-pc-windows-msvc) tag=win32-arm64-msvc ;;
    *)
        echo "unsupported target triple: $triple" >&2
        exit 1
        ;;
esac
addon="zerostack_adapter.${tag}.node"

case $(uname -s) in
    MINGW* | MSYS* | CYGWIN* | Windows_NT) windows=1 ;;
    *) windows=0 ;;
esac

# Panic locations embed source paths: map the build host's home, toolchain, registry and checkout
# to fixed prefixes (the last matching prefix wins, so the most specific mapping comes last).
# rustc on Windows sees drive-letter paths, so Git Bash maps both the POSIX and the native form.
cargo_home=${CARGO_HOME:-$HOME/.cargo}
rustup_home=${RUSTUP_HOME:-$HOME/.rustup}
RUSTFLAGS=${RUSTFLAGS:-}
remap() {
    if [ "$windows" = 1 ] && command -v cygpath >/dev/null 2>&1; then
        RUSTFLAGS="$RUSTFLAGS --remap-path-prefix=$(cygpath -u "$1")$2=$3"
        RUSTFLAGS="$RUSTFLAGS --remap-path-prefix=$(cygpath -w "$1")$(printf '%s' "$2" | tr / '\\')=$3"
    else
        RUSTFLAGS="$RUSTFLAGS --remap-path-prefix=$1$2=$3"
    fi
}
remap "$HOME" "" /build
remap "$cargo_home" "" /cargo
remap "$cargo_home" /registry/src /crates
remap "$rustup_home" "" /rustup
remap "$root" "" .
remap "$(cd "$root" && pwd -P)" "" .
# Apple ld writes object paths as N_OSO stabs (-S omits them, -x drops local symbols) and
# rustc's install name is the absolute output path.
if [ "$(uname -s)" = Darwin ]; then
    RUSTFLAGS="$RUSTFLAGS -C link-arg=-Wl,-S -C link-arg=-Wl,-x"
    RUSTFLAGS="$RUSTFLAGS -C link-arg=-Wl,-install_name,@rpath/$addon"
fi
export RUSTFLAGS

# A failed build must leave no addon behind for the tests to load.
rm -f "$addon"

subcommand=${CARGO_SUBCOMMAND:-build}
target_dir=${CARGO_TARGET_DIR:-$root/target}
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
    cargo "$subcommand" --locked --release --lib --target "$CARGO_BUILD_TARGET"
    profile_dir="$target_dir/${CARGO_BUILD_TARGET%%.2.*}/release"
else
    cargo "$subcommand" --locked --release --lib
    profile_dir="$target_dir/release"
fi

# Symbol listers on Windows print CRLF lines; every pipeline drops the CR before comparing.
nm=${NM:-nm}
if [ "$windows" = 1 ]; then
    cp "$profile_dir/zerostack_adapter.dll" "$addon"
    if command -v dumpbin >/dev/null 2>&1; then
        dumpbin=dumpbin
    else
        vswhere="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
        if [ ! -x "$vswhere" ]; then
            echo "dumpbin is not on PATH and $vswhere is missing" >&2
            exit 1
        fi
        case "${PROCESSOR_ARCHITEW6432:-${PROCESSOR_ARCHITECTURE:-$(uname -m)}}" in
            ARM64 | arm64 | aarch64)
                patterns='VC/Tools/MSVC/*/bin/Hostarm64/arm64/dumpbin.exe VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe'
                ;;
            *)
                patterns='VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe'
                ;;
        esac
        found=""
        for pattern in $patterns; do
            found=$("$vswhere" -latest -products '*' -find "$pattern" | tr -d '\r' | tail -n 1)
            if [ -n "$found" ]; then
                break
            fi
        done
        if [ -z "$found" ]; then
            echo "vswhere found no MSVC dumpbin.exe" >&2
            exit 1
        fi
        dumpbin=$(cygpath -u "$found")
    fi
    # dumpbin lists exports after the "ordinal hint RVA name" header.
    exports=$("$dumpbin" -nologo -exports "$addon" | tr -d '\r' | awk '/ordinal +hint +RVA +name/ {table = 1; next} table && NF >= 4 {print $4} table && /Summary/ {table = 0}')
elif [ "$(uname -s)" = Darwin ]; then
    cp "$profile_dir/libzerostack_adapter.dylib" "$addon"
    install_name=$(otool -D "$addon" | tail -n 1)
    if [ "$install_name" != "@rpath/$addon" ]; then
        echo "$addon install name is $install_name, not @rpath/$addon" >&2
        exit 1
    fi
    # ld records object paths as N_OSO stabs that --remap-path-prefix never sees.
    strip -S -x "$addon"
    stabs=$("$nm" -ap "$addon")
    case $stabs in
        *" OSO "*)
            echo "$addon keeps N_OSO object path stabs after strip" >&2
            exit 1
            ;;
    esac
    exports=$("$nm" -gU "$addon" | tr -d '\r' | awk '{print $NF}' | sed 's/^_napi/napi/')
else
    cp "$profile_dir/libzerostack_adapter.so" "$addon"
    exports=$("$nm" -D --defined-only "$addon" | tr -d '\r' | awk '{print $NF}')
fi

# Build host paths left in the binary (grep exits 1 when nothing matches, 2 on an error).
host_paths='/home/|/Users/|\.cache/act/|/usr/local/(cargo|rustup|src)|/cargo/registry/src/index|[A-Za-z]:\\(Users|a)\\'
set +e
leaks=$(grep -acE "$host_paths" "$addon")
status=$?
set -e
if [ "$status" -gt 1 ]; then
    exit "$status"
fi
if [ "$leaks" != 0 ]; then
    echo "$addon embeds build host paths:" >&2
    grep -aoE "($host_paths)[[:print:]]*" "$addon" | sort -u | head -20 >&2
    exit 1
fi

if [ "$exports" != "napi_register_module_v1" ]; then
    echo "$addon exports more than napi_register_module_v1:" >&2
    echo "$exports" >&2
    exit 1
fi

ls -l "$addon"
