#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Tauri Android auto-build & install (debug mode by default).
Solo corre: python tauri_android_install.py
"""

import subprocess
import sys
import os
import glob
import shutil
from pathlib import Path

def run(cmd, cwd=None):
    print(f"\n==> {cmd}")
    res = subprocess.run(cmd, shell=True, cwd=cwd)
    if res.returncode != 0:
        sys.exit(res.returncode)

def find_debug_apk(project_root):
    gen_root = Path(project_root) / "src-tauri" / "gen" / "android" / "app" / "build" / "outputs" / "apk"
    candidates = [
        str(gen_root / "universal" / "debug" / "*.apk"),
        str(gen_root / "**" / "debug" / "*.apk"),
    ]
    for pat in candidates:
        matches = glob.glob(pat, recursive=True)
        if matches:
            newest = max(matches, key=lambda p: Path(p).stat().st_mtime)
            return newest
    return None

def clean_problematic_dir(project_root):
    problematic = project_root / "src-tauri" / "gen" / "android" / "app" / "build" / "intermediates" / "merged_jni_libs"
    if problematic.exists():
        print(f"[INFO] Borrando carpeta problemática: {problematic}")
        shutil.rmtree(problematic, ignore_errors=True)

def main():
    project_root = Path(__file__).parent.resolve()
    print(f"[INFO] Proyecto: {project_root}")

    # limpiar solo la carpeta conflictiva antes del build
    clean_problematic_dir(project_root)

    # 1) build debug
    run("npm run tauri -- android build --debug", cwd=project_root)

    # 2) encontrar APK
    apk = find_debug_apk(project_root)
    if not apk:
        print("[ERROR] No se encontró APK debug en build outputs")
        sys.exit(1)
    print(f"[OK] APK encontrado: {apk}")

    # 3) instalar en el dispositivo
    run(f'adb install -r "{apk}"')
    print("\n[✓] Instalación completa en el dispositivo Android")

if __name__ == "__main__":
    main()
