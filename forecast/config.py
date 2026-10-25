"""Settings (forecast/config.toml) and the Waste Impact Score lookup (factors/*.csv)."""

from __future__ import annotations

import csv
import os
import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(os.environ.get("FORECAST_CONFIG", REPO / "forecast" / "config.toml"))


@dataclass(frozen=True)
class Settings:
    default_food_cost_usd_per_lb: float
    running_out_usd_per_lb: dict[str, float]
    error_window_days: int
    default_timezone: str
    meals: dict[str, tuple[str, str]]
    factor_files: list[Path]

    def cost_under(self, service_style: str) -> float:
        return self.running_out_usd_per_lb.get(service_style, self.running_out_usd_per_lb["other"])


@lru_cache(maxsize=4)
def load_settings(path: str | None = None) -> Settings:
    raw = tomllib.loads(Path(path or CONFIG_PATH).read_text())
    return Settings(
        default_food_cost_usd_per_lb=float(raw["costs"]["default_food_cost_usd_per_lb"]),
        running_out_usd_per_lb={k: float(v) for k, v in raw["costs"]["running_out_usd_per_lb"].items()},
        error_window_days=int(raw["model"]["error_window_days"]),
        default_timezone=str(raw["model"]["default_timezone"]),
        meals={k: (v[0], v[1]) for k, v in raw["meals"].items()},
        factor_files=[REPO / f for f in raw["factors"]["files"]],
    )


def _norm(name: str) -> str:
    return " ".join(name.lower().replace("&", "and").split())


@lru_cache(maxsize=4)
def impact_scores(files: tuple[Path, ...]) -> dict[str, float]:
    """food name (normalized) -> impact_score_usd_per_kg; earlier files win."""
    out: dict[str, float] = {}
    for f in files:
        if not f.exists():
            continue
        with f.open(newline="") as fh:
            for row in csv.DictReader(fh):
                food, score = row.get("food"), row.get("impact_score_usd_per_kg")
                if food and score and _norm(food) not in out:
                    try:
                        out[_norm(food)] = float(score)
                    except ValueError:
                        continue
    return out


def impact_score_for(food_name: str | None, settings: Settings | None = None) -> float | None:
    if not food_name:
        return None
    s = settings or load_settings()
    return impact_scores(tuple(s.factor_files)).get(_norm(food_name))


@lru_cache(maxsize=4)
def weight_g_per_cm2(files: tuple[Path, ...]) -> dict[str, float]:
    """food name (normalized) -> grams per cm² of visible food (for calibrated tray-waste estimates)."""
    out: dict[str, float] = {}
    for f in files:
        if not f.exists():
            continue
        with f.open(newline="") as fh:
            for row in csv.DictReader(fh):
                food, w = row.get("food"), row.get("weight_g_per_cm2")
                if food and w and _norm(food) not in out:
                    try:
                        out[_norm(food)] = float(w)
                    except ValueError:
                        continue
    return out
