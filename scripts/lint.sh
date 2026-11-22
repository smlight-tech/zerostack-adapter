#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 SMLIGHT
# Unified repository and code hygiene gate.
set -eu

cd "$(dirname "$0")/.."

# 1. SPDX headers (pure POSIX read loops, no sed forks)
# Rust, TypeScript and JavaScript: `//` header lines 1-2, then a blank line.
git ls-files --cached --others --exclude-standard -- '*.rs' '*.ts' '*.d.ts' '*.js' '*.mjs' | {
    bad=0
    while IFS= read -r file; do
        l1=""
        l2=""
        l3=""
        { IFS= read -r l1 && IFS= read -r l2 && IFS= read -r l3; } < "$file" || true
        if [ "$l1" != "// SPDX-License-Identifier: MIT" ] ||
            [ "$l2" != "// Copyright (c) 2026 SMLIGHT" ] ||
            [ -n "$l3" ]; then
            printf 'missing SPDX header: %s\n' "$file" >&2
            bad=1
        fi
    done
    exit "$bad"
}
# Shell, YAML, Python and allowlists: `#` header lines 1-2, or 2-3 after a `#!` line.
git ls-files --cached --others --exclude-standard -- '*.sh' '*.yml' '*.yaml' '*.py' '*.allow' | {
    bad=0
    while IFS= read -r file; do
        l1=""
        l2=""
        l3=""
        { IFS= read -r l1 && IFS= read -r l2 && IFS= read -r l3; } < "$file" || true
        case $l1 in
            "#!"*)
                l1=$l2
                l2=$l3
                ;;
        esac
        if [ "$l1" != "# SPDX-License-Identifier: MIT" ] || [ "$l2" != "# Copyright (c) 2026 SMLIGHT" ]; then
            printf 'missing SPDX header: %s\n' "$file" >&2
            bad=1
        fi
    done
    exit "$bad"
}

# 2. Internal identifiers, hosts and local paths, in files and in commit messages. The pattern is
# spelled so that it does not match itself.
internal='ze{2}sm|z[r]el|s[m]hub|SLZB-Ult[i]ma[0-9]+|LicenseRef-SMLIGHT-Propr[i]etary|/usr/local/s[r]c|/h[o]me/[a-z0-9_-]+|\.l[a]n\b|my[s]tic|radio-b[e]nch'
if git grep --untracked -inE "$internal" -- ':!scripts/lint.sh' ':!scripts/third_party_names.py'; then
    echo "internal identifier, host or local path found" >&2
    exit 1
fi
commits=$(git log --all -i -E --grep="$internal" --format='%h %s')
if [ -n "$commits" ]; then
    printf 'internal identifier in commit messages:\n%s\n' "$commits" >&2
    exit 1
fi

# 3. Third-party project names outside string literals
python3 scripts/third_party_names.py

# 4. Rust lints
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings

# 5. TypeScript and formatting lints
npx biome check --error-on-warnings .
npx tsc --noEmit
