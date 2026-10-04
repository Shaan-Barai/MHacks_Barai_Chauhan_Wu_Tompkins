"""Step 5: score experiment runs against ground_truth.csv.

    python3 vision/scripts/score-experiment.py experiments/experiment_overlays/results.json ground_truth.csv experiments/experiment_summary.csv

Rules (agreed 2026-10-03):
- Ground-truth names are mapped to menu names (misspellings fixed; "Baked Potato"
  = Baked Sweet Potatoes). IMG_2696 / IMG_2704: any pizza counts. IMG_2705
  (pasta, not on menu): not scored. IMG_2706: the pie is scored; extra
  detections are not counted wrong (may be the "Unknown" item).
- Detections under 1% of the plate's food pixels (capture union incl. unknown) are ignored.
- correct = detected and on the plate; missed = on the plate, not detected;
  wrong = detected, not on the plate.
- Runs whose analysis failed (no count) are excluded from scoring and reported.
"""

import csv
import json
import sys

results_path, truth_path, out_path = sys.argv[1:4]
NAME_MAP = {
    'vegstable stiry fry': 'Vegetable Stir Fry Blend',
    'vegstable stir fry': 'Vegetable Stir Fry Blend',
    'roasted caulliflower': 'Roasted Cauliflower',
    'pepperonni pizza': 'Pepperoni Pizza',
    'chochalate cream pie': 'Chocolate Coconut Cream Pie',
    'baked potato': 'Baked Sweet Potatoes',
}
PIZZA = {'Cheese Pizza', 'Pepperoni Pizza', 'Chicken Broccoli Alfredo Pizza'}
ANY_PIZZA = {'IMG_2696', 'IMG_2704'}
NOT_SCORED = {'IMG_2705'}
NO_WRONG = {'IMG_2706'}


def canon(raw):
    name = raw.split('(')[0].strip()
    return NAME_MAP.get(name.lower(), name)


truth = {}
with open(truth_path, newline='', encoding='utf-8-sig') as f:
    for row in csv.reader(f):
        if not row or row[0] == 'Image_name':
            continue
        dishes = set()
        for cell in row[1:]:
            for part in cell.split('&'):
                part = part.strip()
                if part and not part.lower().startswith('unkown') and not part.lower().startswith('unknown'):
                    dishes.add(canon(part))
        truth[row[0].strip()] = dishes

runs = json.load(open(results_path))
per_source = {}
detected_by = {}
failed = []
for r in runs:
    photo = r['file'].rsplit('.', 1)[0]
    src = r['menuSource']
    s = per_source.setdefault(src, {'correct': 0, 'missed': 0, 'wrong': 0, 'unknown': [], 'scored_runs': 0, 'failed_runs': 0})
    if r['countStatus'] not in ('complete', 'empty'):
        s['failed_runs'] += 1
        failed.append(f"{photo} {src} run{r['run']} ({r['status']}/{r['countStatus']})")
        continue
    food_px = r['capturePixels']
    dets = {i['food'] for i in r['items'] if not i['food'].startswith('unknown') and food_px > 0 and i['pixels'] >= 0.01 * food_px}
    detected_by.setdefault((photo, src), {})[r['run']] = dets
    s['unknown'].append(r['unknownPct'])
    if photo in NOT_SCORED:
        continue
    s['scored_runs'] += 1
    t = truth.get(photo, set())
    if photo in ANY_PIZZA:
        hit = bool(dets & PIZZA)
        s['correct'] += 1 if hit else 0
        s['missed'] += 0 if hit else 1
        s['wrong'] += len(dets - PIZZA)
        continue
    s['correct'] += len(dets & t)
    s['missed'] += len(t - dets)
    if photo not in NO_WRONG:
        s['wrong'] += len(dets - t)

rows = []
for src in sorted(per_source):
    s = per_source[src]
    pairs = [v for (p, sr), v in detected_by.items() if sr == src and 1 in v and 2 in v]
    differ = sum(1 for v in pairs if v[1] != v[2])
    rows.append({
        'menu_source': src,
        'scored_runs': s['scored_runs'],
        'failed_runs': s['failed_runs'],
        'correct': s['correct'],
        'missed': s['missed'],
        'wrong': s['wrong'],
        'avg_unknown_pct': round(sum(s['unknown']) / len(s['unknown']), 2) if s['unknown'] else '',
        'run_pairs_compared': len(pairs),
        'run_pairs_different': differ,
        'run_disagreement_rate': round(differ / len(pairs), 3) if pairs else '',
    })
with open(out_path, 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print('ground truth used:', {k: sorted(v) for k, v in sorted(truth.items())})
print('failed runs excluded:', failed or 'none')
for row in rows:
    print(row)
