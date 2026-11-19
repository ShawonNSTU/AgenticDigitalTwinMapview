"""Synthetic floor plans with known rooms and doors, in a few drawing styles, for testing plan_cv."""
from __future__ import annotations

import math

import cv2
import numpy as np

# rooms in metres (x0, y0, x1, y1); a 12 x 9 m flat
FLAT = [
    ("LIVING ROOM", (0, 0, 6, 5)),
    ("KITCHEN", (6, 0, 9, 3)),
    ("DINING", (9, 0, 12, 3)),
    ("HALL", (6, 3, 12, 4.5)),
    ("BEDROOM", (0, 5, 4.5, 9)),
    ("BATH", (4.5, 5, 6.5, 9)),
    ("STUDY", (6.5, 4.5, 9, 9)),
    ("MASTER BEDROOM", (9, 4.5, 12, 9)),
]
# doors: (x, y) centre on a wall line, width, orientation of the wall ('h' or 'v')
FLAT_DOORS = [
    ((6, 4.0), 0.9, "v"),     # living - hall
    ((7.5, 3), 0.9, "h"),     # kitchen - hall
    ((10.5, 3), 0.9, "h"),    # dining - hall
    ((2.2, 5), 0.9, "h"),     # living - bedroom
    ((5.5, 5), 0.8, "h"),     # living - bath
    ((7.8, 4.5), 0.9, "h"),   # hall - study
    ((10.5, 4.5), 0.9, "h"),  # hall - master
    ((12, 3.75), 1.0, "v"),   # front door: hall - outside
]


def draw(style: str = "thick", px_per_m: float = 60, margin_m: float = 1.5, rooms=FLAT, door_list=FLAT_DOORS, extras: bool = True, skew: bool = False):
    W_m = max(r[1][2] for r in rooms) + 2 * margin_m
    H_m = max(r[1][3] for r in rooms) + 2 * margin_m
    W, H = int(W_m * px_per_m), int(H_m * px_per_m)
    img = np.full((H, W, 3), 255, np.uint8)
    P = lambda x, y: (int(round((x + margin_m) * px_per_m)), int(round((y + margin_m) * px_per_m)))
    t = {"thick": 0.2, "hatched": 0.25, "thin": 0.08, "grey": 0.18}[style]
    tp = max(2, int(round(t * px_per_m)))
    colour = (40, 40, 40) if style != "grey" else (120, 120, 120)
    walls = np.zeros((H, W), np.uint8)
    for _, (x0, y0, x1, y1) in rooms:
        cv2.rectangle(walls, P(x0, y0), P(x1, y1), 255, tp)
    # cut door openings
    for (x, y), w, o in door_list:
        if o == "h":
            a, b = P(x - w / 2, y), P(x + w / 2, y)
            cv2.rectangle(walls, (a[0], a[1] - tp), (b[0], b[1] + tp), 0, -1)
        else:
            a, b = P(x, y - w / 2), P(x, y + w / 2)
            cv2.rectangle(walls, (a[0] - tp, a[1]), (b[0] + tp, b[1]), 0, -1)
    if style == "hatched":
        img[walls > 0] = (255, 255, 255)
        cs, _ = cv2.findContours(walls, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(img, cs, -1, (30, 30, 30), 2)
        hatch = np.zeros_like(walls)
        for k in range(-H, W, 6):
            cv2.line(hatch, (k, 0), (k + H, H), 255, 1)
        img[(hatch > 0) & (walls > 0)] = (30, 30, 30)
    else:
        img[walls > 0] = colour
    if extras:
        thin = (110, 110, 110)
        # door swings
        for (x, y), w, o in door_list:
            c = P(x - w / 2, y) if o == "h" else P(x, y - w / 2)
            r = int(w * px_per_m)
            cv2.ellipse(img, c, (r, r), 0, 0, 90, thin, 1)
        # furniture outlines and labels
        for name, (x0, y0, x1, y1) in rooms:
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            fs = 0.5 * px_per_m / 60
            (tw, th), _ = cv2.getTextSize(name, cv2.FONT_HERSHEY_SIMPLEX, fs, 1)
            q = P(cx, cy)
            cv2.putText(img, name, (q[0] - tw // 2, q[1] + th // 2), cv2.FONT_HERSHEY_SIMPLEX, fs, (0, 0, 0), 1, cv2.LINE_AA)
            if "BED" in name:
                cv2.rectangle(img, P(x0 + 0.4, y1 - 2.4), P(x0 + 2.0, y1 - 0.4), thin, 1)
            if "LIVING" in name:
                cv2.rectangle(img, P(x0 + 0.5, y0 + 0.4), P(x0 + 2.6, y0 + 1.3), thin, 1)
        # dimension line above the plan
        a, b = P(0, -0.8), P(max(r[1][2] for r in rooms), -0.8)
        cv2.line(img, a, b, thin, 1)
        cv2.putText(img, "12000", ((a[0] + b[0]) // 2 - 20, a[1] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.4, thin, 1)
    if skew:
        src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
        dst = np.float32([[0.12 * W, 0.1 * H], [0.9 * W, 0.04 * H], [0.95 * W, 0.92 * H], [0.06 * W, 0.85 * H]])
        M = cv2.getPerspectiveTransform(src, dst)
        img = cv2.warpPerspective(img, M, (W, H), borderValue=(60, 70, 80))
    truth_rooms = [(n, ((x0 + margin_m) / W_m, (y0 + margin_m) / H_m, (x1 + margin_m) / W_m, (y1 + margin_m) / H_m)) for n, (x0, y0, x1, y1) in rooms]
    truth_doors = [((x + margin_m) / W_m, (y + margin_m) / H_m, w, o) for (x, y), w, o in door_list]
    return img, {"rooms": truth_rooms, "doors": truth_doors, "width_m": W_m}


def iou_rect(poly, rect, shape=(400, 400)) -> float:
    H, W = shape
    a = np.zeros(shape, np.uint8)
    b = np.zeros(shape, np.uint8)
    cv2.fillPoly(a, [np.array([[p[0] * W, p[1] * H] for p in poly], np.int32)], 1)
    x0, y0, x1, y1 = rect
    cv2.rectangle(b, (int(x0 * W), int(y0 * H)), (int(x1 * W), int(y1 * H)), 1, -1)
    inter = np.logical_and(a, b).sum()
    uni = np.logical_or(a, b).sum()
    return inter / uni if uni else 0.0
