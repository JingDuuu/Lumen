"""Local paths shared by the desktop, CLI, engine and installers."""
from dataclasses import dataclass
import json
import os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent


@dataclass(frozen=True)
class RuntimeConfig:
    app_root: Path
    comfy_dir: Path
    engine_python: Path
    data_dir: Path
    input_dir: Path
    output_dir: Path
    log_dir: Path
    engine_log_dir: Path

    @property
    def models_dir(self):
        return self.comfy_dir / "models"

    def as_dict(self):
        return {name: str(value) for name, value in self.__dict__.items()} | {"models_dir": str(self.models_dir)}


def load_config(app_root=APP_ROOT, environ=None):
    env = os.environ if environ is None else environ
    app_root = Path(app_root).resolve()
    config_path = Path(env.get("LUMEN_CONFIG", app_root / "lumen.local.json")).expanduser().resolve()
    values = json.loads(config_path.read_text(encoding="utf-8-sig")) if config_path.exists() else {}
    if not isinstance(values, dict):
        raise ValueError("Lumen 路径配置必须是 JSON 对象")
    legacy = (app_root.parent / "main.py").is_file() and (app_root.parent / "comfy").is_dir()

    def path(key, fallback):
        value = env.get("LUMEN_" + key.upper(), values.get(key, fallback))
        result = Path(os.path.expandvars(str(value))).expanduser()
        return (config_path.parent / result).resolve() if not result.is_absolute() else result.resolve()

    comfy = path("comfy_dir", app_root.parent if legacy else app_root / "runtime" / "ComfyUI")
    python = path("engine_python", comfy / "venv" / "Scripts" / "python.exe" if legacy else app_root / ".venv" / "Scripts" / "python.exe")
    data = path("data_dir", app_root if legacy else app_root / "data")
    logs = path("log_dir", data if legacy else data / "logs")
    return RuntimeConfig(app_root, comfy, python, data,
                         path("input_dir", comfy / "input" if legacy else data / "input"),
                         path("output_dir", comfy / "output" if legacy else data / "output"),
                         logs, path("engine_log_dir", comfy if legacy else logs))


CONFIG = load_config()

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--print", dest="field", choices=list(CONFIG.as_dict()))
    args = parser.parse_args()
    print(CONFIG.as_dict()[args.field] if args.field else json.dumps(CONFIG.as_dict(), ensure_ascii=False, indent=2))
