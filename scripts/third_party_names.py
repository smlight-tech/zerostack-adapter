#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 SMLIGHT
"""Rejects names of third-party host projects in the code under src/ (Rust) and ts/.

Comments and docstrings cite the standard or vendor interface instead. String literals are
not checked: they hold wire values, file formats and user-facing feature names. Identifiers that
must keep a name, and licence attribution lines (as `line: <exact source line>`), are listed in
scripts/third_party_names.allow.

    python3 scripts/third_party_names.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TERMS = re.compile(r'zigpy|bellows|zigbee2mqtt|ze{2}sm', re.IGNORECASE)
SUFFIXES = ('.rs', '.ts', '.tsx', '.js', '.mjs')
# Rust raw strings, then double-quoted strings; single-quoted and template strings only outside
# Rust, where a single quote also starts a lifetime.
RUST_STRINGS = re.compile(r'r(#*)"(?:.|\n)*?"\1|b?"(?:\\.|[^"\\])*"', re.DOTALL)
SCRIPT_STRINGS = re.compile(r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|`(?:\\.|[^`\\])*`', re.DOTALL)


def blank(match):
    # Keeps line breaks so reported line numbers stay right.
    return re.sub(r'[^\n]', ' ', match.group(0))


def allowed():
    entries = (ROOT / 'scripts' / 'third_party_names.allow').read_text(encoding='utf-8').splitlines()
    entries = [entry.strip() for entry in entries if entry.strip() and not entry.startswith('#')]
    lines = {entry.removeprefix('line:').strip() for entry in entries if entry.startswith('line:')}
    return {entry for entry in entries if not entry.startswith('line:')}, lines


def main():
    names, attributions = allowed()
    # Tracked and new files alike, so the check also runs before a commit.
    files = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'ts'],
                           cwd=ROOT, check=True, capture_output=True, text=True).stdout.split()
    found = []
    for name in files:
        if not name.endswith(SUFFIXES):
            continue
        text = (ROOT / name).read_text(encoding='utf-8')
        source = text.split('\n')
        strings = RUST_STRINGS if name.endswith('.rs') else SCRIPT_STRINGS
        code = strings.sub(blank, text)
        for match in TERMS.finditer(code):
            start = code.rfind('\n', 0, match.start()) + 1
            word = re.match(r'\w*', code[match.start():]).group(0)
            word = re.search(r'\w*$', code[start:match.start()]).group(0) + word
            line = code.count('\n', 0, match.start()) + 1
            if word in names or source[line - 1].strip() in attributions:
                continue
            found.append(f'{name}:{line}: {word}')
    for entry in found:
        print(entry)
    if found:
        print(f'{len(found)} third-party project names outside string literals: cite the standard or vendor '
              'interface instead, or list a feature identifier in scripts/third_party_names.allow', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
