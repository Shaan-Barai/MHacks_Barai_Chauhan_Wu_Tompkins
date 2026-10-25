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


LB_PER_KG = 2.2046226218


@dataclass(frozen=True)
class Settings:
    default_food_cost_usd_per_lb: float
    reference_impact_usd_per_kg: float
    service_level: dict[str, float]
    error_window_days: int
    default_timezone: str
    meals: dict[str, tuple[str, str]]
    factor_files: list[Path]
    context: dict[str, object]

    @property
    def reference_cost_over(self) -> float:
        """Co of a typical dish: default food cost + the reference impact score per lb."""
        return self.default_food_cost_usd_per_lb + self.reference_impact_usd_per_kg / LB_PER_KG

    def target_q(self, service_style: str) -> float:
        return self.service_level.get(service_style, self.service_level["other"])

    def cost_under(self, service_style: str) -> float:
        """Cu per lb short, chosen so a typical dish of this style gets exactly its service level."""
        q = self.target_q(service_style)
        return q / (1.0 - q) * self.reference_cost_over


@lru_cache(maxsize=4)
def load_settings(path: str | None = None) -> Settings:
    raw = tomllib.loads(Path(path or CONFIG_PATH).read_text())
    levels = {k: float(v) for k, v in raw["service_level"].items()}
    for style, q in levels.items():
        if not 0.5 <= q < 1.0:
            raise ValueError(f"service_level.{style} = {q}: use a value from 0.5 up to (not including) 1")
    return Settings(
        default_food_cost_usd_per_lb=float(raw["costs"]["default_food_cost_usd_per_lb"]),
        reference_impact_usd_per_kg=float(raw["costs"]["reference_impact_usd_per_kg"]),
        service_level=levels,
        error_window_days=int(raw["model"]["error_window_days"]),
        default_timezone=str(raw["model"]["default_timezone"]),
        meals={k: (v[0], v[1]) for k, v in raw["meals"].items()},
        factor_files=[REPO / f for f in raw["factors"]["files"]],
        context=dict(raw.get("context", {})),
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
