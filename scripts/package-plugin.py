import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "kimi.plugin.json").read_text(encoding="utf-8"))
output = root / "dist" / "release" / f"kimi-code-web-search-{manifest['version']}.zip"
required = ("lib/host/gateway-server.js", "dist/client/index.html", "dist/client/app.js")
for entry in required:
    if not (root / entry).is_file():
        raise SystemExit(f"Missing {entry}; run npm run build first.")

with tempfile.TemporaryDirectory(prefix="kimi-web-plugin-") as tmp:
    stage = Path(tmp)
    for name in ("package.json", "package-lock.json"):
        shutil.copy2(root / name, stage / name)
    subprocess.run(
        ["npm.cmd" if os.name == "nt" else "npm", "ci", "--omit=dev", "--include=optional", "--ignore-scripts", "--no-bin-links"],
        cwd=stage, check=True,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    # ponytail: ship the locked JS dependencies as files; revisit platform builds if a native runtime dependency is added.
    with tempfile.TemporaryDirectory(dir=output.parent) as tmp_output:
        archive = Path(tmp_output) / output.name
        with ZipFile(archive, "w", compression=ZIP_DEFLATED) as package:
            for base, entries in (
                (root, ("kimi.plugin.json", "SYSTEM.md", "LICENSE", "README.md", "README.zh-CN.md", "bin", "hooks", "skills", "commands", "assets", "lib", "dist/client")),
                (stage, ("package.json", "node_modules")),
            ):
                for name in entries:
                    entry = base / name
                    for file in sorted(entry.rglob("*") if entry.is_dir() else [entry]):
                        if file.is_symlink():
                            raise SystemExit(f"Unexpected symlink in plugin package: {file.relative_to(base)}")
                        if file.is_file():
                            package.write(file, file.relative_to(base).as_posix())
        archive.replace(output)

print(output.relative_to(root))
