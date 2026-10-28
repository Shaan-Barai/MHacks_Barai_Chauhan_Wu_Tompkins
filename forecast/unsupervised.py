"""Unsupervised helpers for the forecast, both OFF by default (forecast/config.toml).

[clustering] enabled = true
    Day-type clustering: k-means on each past day's attendance profile (share of
    the day's swipes per meal, and total diners scaled to the busiest day) plus its
    context flags. Each day gets a type id; gbm-v1 uses the type of the same weekday
    last week as a feature. Days are clustered only from data known on that day.

[anomaly] enabled = true
    Robust z-score on confirmed production_log rows: for each dish and meal, z =
    0.6745 x (consumed - median) / MAD. Rows with |z| > threshold (default 3.5) are
    routed to review (listed, with the reason) and left out of training. Nothing is
    deleted or changed in the database by this module.

Standard library only; deterministic for a fixed seed.
"""

from __future__ import annotations

import random
from collections import defaultdict
from datetime import date
from statistics import median

from .model import Observation

MEALS = ("breakfast", "lunch", "dinner")
CONTEXT_KEYS = ("exam_week", "home_game", "is_holiday")


def day_profiles(attendance: dict[tuple[date, str], float], context: dict[date, set[str]]) -> dict[date, list[float]]:
    days = sorted({d for d, _ in attendance})
    totals = {d: sum(attendance.get((d, m), 0.0) for m in MEALS) for d in days}
    peak = max(totals.values(), default=0.0) or 1.0
    out = {}
    for d in days:
        t = totals[d]
        if t <= 0:
            continue
        flags = context.get(d, set())
        out[d] = [attendance.get((d, m), 0.0) / t for m in MEALS] + [t / peak] + [1.0 if k in flags else 0.0 for k in CONTEXT_KEYS]
    return out


def kmeans(points: list[list[float]], k: int, seed: int = 0, iterations: int = 50) -> tuple[list[int], list[list[float]]]:
    """Plain k-means (k-means++ start). Returns (label per point, centroids)."""
    if not points:
        return [], []
    k = max(1, min(k, len(points)))
    rng = random.Random(seed)
    dist = lambda a, b: sum((x - y) ** 2 for x, y in zip(a, b))  # noqa: E731
    cents = [list(points[rng.randrange(len(points))])]
    while len(cents) < k:
        d2 = [min(dist(p, c) for c in cents) for p in points]
        total = sum(d2)
        if total == 0:
            break
        r, acc = rng.random() * total, 0.0
        for p, w in zip(points, d2):
            acc += w
            if acc >= r:
                cents.append(list(p))
                break
    labels = [0] * len(points)
    for _ in range(iterations):
        new = [min(range(len(cents)), key=lambda j: dist(p, cents[j])) for p in points]
        if new == labels and _ > 0:
            break
        labels = new
        for j in range(len(cents)):
            members = [p for p, l in zip(points, labels) if l == j]
            if members:
                cents[j] = [sum(col) / len(members) for col in zip(*members)]
    return labels, cents


def day_types(attendance: dict[tuple[date, str], float], context: dict[date, set[str]], k: int = 4, seed: int = 0) -> dict[date, int]:
    """date -> day-type id, from each day's own profile (a past day's swipes are known after that day)."""
    prof = day_profiles(attendance, context)
    days = sorted(prof)
    labels, _ = kmeans([prof[d] for d in days], k, seed)
    return dict(zip(days, labels))


def robust_z_anomalies(history: list[Observation], threshold: float = 3.5, min_rows: int = 5) -> list[dict]:
    """Confirmed rows whose consumed lb is far from the dish-meal median (robust z, MAD-based)."""
    groups: dict[tuple[str, str], list[Observation]] = defaultdict(list)
    for o in history:
        if o.consumed_lb is not None and not o.censored:
            groups[(o.dish_id, o.meal)].append(o)
    out = []
    for (dish, meal), obs in groups.items():
        if len(obs) < min_rows:
            continue
        vals = [o.consumed_lb for o in obs]
        med = median(vals)
        mad = median(abs(v - med) for v in vals)
        if mad == 0:
            continue
        for o in obs:
            z = 0.6745 * (o.consumed_lb - med) / mad
            if abs(z) > threshold:
                out.append({"service_date": o.service_date.isoformat(), "meal": meal, "dish_id": dish, "consumed_lb": round(o.consumed_lb, 2),
                            "median_lb": round(med, 2), "robust_z": round(z, 2), "reason": f"robust z {z:.1f} (|z| > {threshold})"})
    return sorted(out, key=lambda r: -abs(r["robust_z"]))


def without_anomalies(history: list[Observation], anomalies: list[dict]) -> list[Observation]:
    bad = {(a["service_date"], a["meal"], a["dish_id"]) for a in anomalies}
    return [o for o in history if (o.service_date.isoformat(), o.meal, o.dish_id) not in bad]
