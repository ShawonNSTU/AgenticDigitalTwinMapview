"""Floor plan geometry from the image itself, with OpenCV. Works without any API key.

Pipeline:
  1. A photo of a sheet taken at an angle is detected (paper outline) and reported as photo_corners.
  2. Dark ink is split into walls (the thickest long strokes) and everything else (text, furniture, dimensions).
  3. Door openings are closed: every wall end casts a ray along its wall; a ray that meets another wall within a
     door's width closes the gap. Each closure that separates two spaces is a door.
  4. The enclosed free space, minus the outside, splits into rooms. Each room grows into the walls up to the
     wall centre line, so neighbouring rooms share exact wall lines.
  5. Outlines are simplified and squared up (near-horizontal and near-vertical edges snapped to shared lines).
  6. Room names come from the text printed inside each room (Tesseract OCR, if installed).
  7. The scale comes from the doors (a door is about 0.85 m wide), else from the wall thickness.

All output coordinates are fractions of the image (x right, y down), like the vision model's output.
"""
from __future__ import annotations

import math
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass

import cv2
import numpy as np

MAX_SIDE = 1600
DOOR_M = 0.85          # typical clear opening of an interior door
WALL_M = 0.15          # typical wall thickness, used when no doors are found


@dataclass
class Closure:
    a: np.ndarray       # face of the wall end
    b: np.ndarray       # where the ray met the next wall
    u: np.ndarray       # unit direction a -> b


def decode(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not an image")
    return img


# ---------------------------------------------------------------- photo of a sheet

def sheet_corners(gray: np.ndarray) -> list | None:
    """Four corners (TL, TR, BR, BL; fractions) of a sheet of paper photographed at an angle, else None."""
    h, w = gray.shape
    blur = cv2.GaussianBlur(gray, (7, 7), 0)
    _, bright = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    cs, _ = cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cs:
        return None
    c = max(cs, key=cv2.contourArea)
    area = cv2.contourArea(c)
    if not 0.2 * w * h < area < 0.93 * w * h:
        return None
    quad = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
    if len(quad) != 4 or not cv2.isContourConvex(quad):
        return None
    q = quad.reshape(4, 2).astype(float)
    s, d = q.sum(1), q[:, 0] - q[:, 1]
    tl, br, tr, bl = q[s.argmin()], q[s.argmax()], q[d.argmax()], q[d.argmin()]
    # skewed if any side is visibly off-axis
    def tilt(p, r):
        a = math.degrees(math.atan2(r[1] - p[1], r[0] - p[0])) % 90
        return min(a, 90 - a)
    if max(tilt(tl, tr), tilt(bl, br), tilt(tl, bl), tilt(tr, br)) < 2.5:
        return None
    return [[round(p[0] / w, 4), round(p[1] / h, 4)] for p in (tl, tr, br, bl)]


def clear_background(gray: np.ndarray) -> np.ndarray:
    """Whiten large dark areas touching the image edge: table or desk around a photographed sheet,
    or the margins a straightened photo leaves."""
    H, W = gray.shape
    otsu, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = (cv2.GaussianBlur(gray, (5, 5), 0) < min(otsu, 170)).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark, 8)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    out = gray
    for i in edge:
        x, y, w, h, a = st[i]
        if a < 0.02 * W * H:
            continue
        # solid, not line work: somewhere it is far thicker than any wall
        m = cv2.copyMakeBorder((lab[y:y + h, x:x + w] == i).astype(np.uint8), 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
        if cv2.distanceTransform(m, cv2.DIST_L2, 3).max() > 0.025 * min(W, H):
            if out is gray:
                out = gray.copy()
            out[cv2.dilate((lab == i).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0] = 255
    return out


# ---------------------------------------------------------------- walls

def ink(gray: np.ndarray, close: int = 3) -> np.ndarray:
    h, w = gray.shape
    block = max(15, (max(h, w) // 40) | 1)
    adaptive = cv2.adaptiveThreshold(cv2.GaussianBlur(gray, (3, 3), 0), 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block, 12)
    otsu, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    solid = (gray < min(otsu, 150)).astype(np.uint8) * 255   # filled walls the adaptive threshold hollows out
    dark = cv2.bitwise_or(adaptive, solid)
    return cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((close, close), np.uint8))   # 7: fill hatching


def wall_half_thickness(dark: np.ndarray) -> float:
    """Half the wall thickness in px: the stroke half-width that carries most of the long thick ink."""
    dt = cv2.distanceTransform(dark, cv2.DIST_L2, 5)
    ridge = (dt >= cv2.dilate(dt, np.ones((3, 3), np.uint8))) & (dt >= 1)
    # only elongated strokes count: filled columns, solid symbols and bold text are compact
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark, 8)
    mx = np.zeros(n, np.float32)
    np.maximum.at(mx, lab[ridge], dt[ridge])
    elong = st[:, cv2.CC_STAT_AREA] / np.maximum(4 * mx ** 2, 1)
    ok = elong >= 5
    ok[0] = False
    ridge &= ok[lab]
    v = dt[ridge]
    if v.size < 50:
        return 1.5
    v = v[v >= 1.5]
    if v.size < 50:
        return 1.5
    # weight thicker strokes more: text and furniture are thin, walls are thick and long
    bins = np.round(v * 2) / 2
    vals, counts = np.unique(bins, return_counts=True)
    weight = counts * vals ** 2
    # largest bin with real mass (≥ 15 % of the peak) among the upper half of the weight
    cum = np.cumsum(weight) / weight.sum()
    cand = vals[(cum >= 0.35)]
    peak = weight.max()
    good = [x for x, wt in zip(vals, weight) if wt >= 0.15 * peak and x in cand]
    h = float(np.median(good)) if good else float(vals[weight.argmax()])
    return max(1.5, min(h, 40.0))


def wall_mask(dark: np.ndarray, h: float) -> np.ndarray:
    H, W = dark.shape
    if h >= 2.0:
        dt = cv2.distanceTransform(dark, cv2.DIST_L2, 5)
        core = (dt >= 0.6 * h).astype(np.uint8) * 255
        r = int(math.ceil(h)) + 1
        walls = cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
        walls = cv2.bitwise_and(walls, cv2.dilate(dark, np.ones((3, 3), np.uint8)))
    else:
        walls = dark.copy()
    # drop specks: text, columns of other drawings, noise. Keep long or heavy pieces.
    n, lab, st, _ = cv2.connectedComponentsWithStats(walls, 8)
    keep = np.zeros(n, bool)
    diag = math.hypot(W, H)
    for i in range(1, n):
        x, y, w, hh, a = st[i]
        if math.hypot(w, hh) > 0.06 * diag or a > (8 * h) ** 2:
            keep[i] = True
    return (keep[lab] * 255).astype(np.uint8)


# ---------------------------------------------------------------- door gaps

def _thin(mask: np.ndarray) -> np.ndarray:
    if hasattr(cv2, "ximgproc"):
        return cv2.ximgproc.thinning(mask)
    from skimage.morphology import skeletonize  # optional fallback
    return (skeletonize(mask > 0) * 255).astype(np.uint8)


def _trace(sk: np.ndarray, x: int, y: int, limit: int) -> tuple[list, bool]:
    """Walk along the skeleton from an end point. Returns the path and whether it stopped at a junction."""
    H, W = sk.shape
    path = [(x, y)]
    seen = {(x, y)}
    cx, cy = x, y
    for _ in range(limit):
        nxt = [(cx + dx, cy + dy) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
               if (dx or dy) and 0 <= cx + dx < W and 0 <= cy + dy < H and sk[cy + dy, cx + dx] and (cx + dx, cy + dy) not in seen]
        if len(nxt) == 2 and abs(nxt[0][0] - nxt[1][0]) + abs(nxt[0][1] - nxt[1][1]) == 1:
            nxt = [min(nxt, key=lambda q: abs(q[0] - cx) + abs(q[1] - cy))]   # a stair step, not a fork
        if len(nxt) != 1:
            return path, len(nxt) > 1
        cx, cy = nxt[0]
        seen.add((cx, cy))
        path.append((cx, cy))
    return path, False


def _ends(sk: np.ndarray):
    nb = cv2.filter2D(sk, -1, np.ones((3, 3), np.float32), borderType=cv2.BORDER_CONSTANT) - sk
    ys, xs = np.nonzero((sk == 1) & (nb == 1))
    return list(zip(xs.tolist(), ys.tolist()))


def wall_ends(walls: np.ndarray, h: float) -> list[tuple[np.ndarray, np.ndarray]]:
    """Skeleton end points of the walls with the outward direction of the wall at that end.

    Thinning leaves short forks at the square ends of thick walls; those spurs (short branches that end in a
    junction) are removed first. The direction is read by walking back along the skeleton until a junction or
    a few wall thicknesses, so a short stub next to a corner still points along its own wall.
    """
    sk = (_thin(walls) > 0).astype(np.uint8)
    spur = max(3, int(round(1.3 * h)))
    for _ in range(2):
        for x, y in _ends(sk):
            path, junction = _trace(sk, x, y, spur)
            if junction and len(path) <= spur:
                for px, py in path:
                    sk[py, px] = 0
    out = []
    R = max(6, int(4 * h))
    for x, y in _ends(sk):
        path, _ = _trace(sk, x, y, R)
        if len(path) < 2:
            continue
        d = np.array([x, y], float) - np.array(path[-1], float)
        n = np.linalg.norm(d)
        if n < 1e-6:
            continue
        d /= n
        # curved strokes (door swings, round furniture) are not walls
        pts = np.array(path, float) - np.array([x, y], float)
        if len(path) > 6 and np.abs(pts[:, 0] * d[1] - pts[:, 1] * d[0]).max() > max(1.5, 0.3 * h):
            continue
        ang = math.degrees(math.atan2(d[1], d[0]))
        snapped = round(ang / 90) * 90
        # a short stub's direction is rough: trust an angled direction only on a long straight wall
        if abs(ang - snapped) < 12 or (len(path) < 3 * h and abs(ang - snapped) < 30):
            d = np.array([math.cos(math.radians(snapped)), math.sin(math.radians(snapped))])
        elif len(path) < 3 * h:
            continue
        out.append((np.array([x, y], float), d))
    return out


def close_gaps(walls: np.ndarray, h: float) -> tuple[np.ndarray, list[Closure]]:
    H, W = walls.shape
    t = 2 * h
    max_gap = min(13 * t + 6, 0.12 * max(H, W))
    closures: list[Closure] = []
    for p, d0 in wall_ends(walls, h):
        # the traced direction, then the nearest axis directions (short stubs give rough directions)
        a0 = math.degrees(math.atan2(d0[1], d0[0]))
        dirs = [d0] + [np.array([math.cos(math.radians(a)), math.sin(math.radians(a))])
                       for a in sorted((k * 90 for k in range(-2, 3)), key=lambda a: abs(a - a0)) if 0.5 < abs(a - a0) < 35]
        for d in dirs:
            # leave the wall first (the skeleton end lies somewhere inside it), then look for the next wall
            k = 0.0
            while k < 4 * h + 4:
                q = p + d * k
                xi, yi = int(round(q[0])), int(round(q[1]))
                if not (0 <= xi < W and 0 <= yi < H) or not walls[yi, xi]:
                    break
                k += 1
            face = p + d * k
            start = k
            hit = None
            while k - start < max_gap:
                q = p + d * k
                xi, yi = int(round(q[0])), int(round(q[1]))
                if not (0 <= xi < W and 0 <= yi < H):
                    break
                if walls[yi, xi]:
                    hit = q
                    break
                k += 1
            if hit is not None and k - start >= max(3.0, 0.8 * t):
                closures.append(Closure(face, hit, d))
                break
    return _draw_closures(walls, closures, h), closures


def _draw_closures(walls: np.ndarray, closures: list[Closure], h: float) -> np.ndarray:
    barrier = walls.copy()
    th = max(2, int(round(2 * h)))
    for c in closures:
        cv2.line(barrier, tuple(int(v) for v in np.round(c.a)), tuple(int(v) for v in np.round(c.b)), 255, th)
    return barrier


def _sides(c: Closure, rooms: np.ndarray, foot: np.ndarray, h: float) -> list[int]:
    """What lies on each side of a closure: a room (>0), the outside (-1), or nothing usable (0: wall or sliver)."""
    H, W = rooms.shape
    t = 2 * h
    mid = (c.a + c.b) / 2
    nrm = np.array([-c.u[1], c.u[0]])
    sides = []
    for s in (1, -1):
        v = 0
        for off in (1.2 * t + 2, 2 * t + 3):
            q = mid + nrm * s * off
            xi, yi = int(round(q[0])), int(round(q[1]))
            if not (0 <= xi < W and 0 <= yi < H) or foot[yi, xi] == 0:
                v = -1
            else:
                v = int(rooms[yi, xi])
            if v != 0:
                break
        sides.append(v)
    return sides


# ---------------------------------------------------------------- rooms

def footprint(barrier: np.ndarray, h: float) -> np.ndarray:
    """The building's area: walls with every opening up to a wide door closed, holes filled."""
    H, W = barrier.shape
    L = int(min(14 * 2 * h + 8, 0.15 * max(H, W))) | 1
    # pad first: closing treats pixels beyond the image edge as ink and would seal walls to the border
    big = cv2.copyMakeBorder(barrier, L, L, L, L, cv2.BORDER_CONSTANT, value=0)
    big = cv2.morphologyEx(big, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (L, 1)))
    big = cv2.morphologyEx(big, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, L)))
    closed = cv2.bitwise_or(big[L:-L, L:-L], barrier)
    ff = closed.copy()
    pad = cv2.copyMakeBorder(ff, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    mask = np.zeros((H + 4, W + 4), np.uint8)
    cv2.floodFill(pad, mask, (0, 0), 128)
    outside = pad[1:-1, 1:-1] == 128
    return (~outside).astype(np.uint8) * 255


def room_labels(barrier: np.ndarray, h: float) -> tuple[np.ndarray, int, np.ndarray]:
    H, W = barrier.shape
    foot = footprint(barrier, h)
    free = ((barrier == 0) & (foot > 0)).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(free, 4)
    outside = set()
    # a drawing frame encloses the outside too: a space spanning nearly the whole sheet is outside
    for i in range(1, n):
        x, y, w, hh, a = st[i]
        if w > 0.85 * W and hh > 0.85 * H and a > 0.25 * W * H:
            outside.add(i)
    inner = [i for i in range(1, n) if i not in outside]
    if not inner:
        return np.zeros_like(lab), 0, foot
    bx = [st[i] for i in inner]
    bld = (max(b[0] + b[2] for b in bx) - min(b[0] for b in bx)) * (max(b[1] + b[3] for b in bx) - min(b[1] for b in bx))
    t = 2 * h
    min_area = max((4.5 * t) ** 2, 0.0025 * bld, 150)
    out = np.zeros(lab.shape, np.int32)
    bpad = cv2.copyMakeBorder(barrier, 3, 3, 3, 3, cv2.BORDER_CONSTANT, value=0)
    k = 0
    for i in inner:
        x, y, w, hh, a = st[i]
        if a < min_area or min(w, hh) < 2.5 * t:
            continue
        m = (lab[y:y + hh, x:x + w] == i).astype(np.uint8)
        # a room is mostly walled in; spaces bounded by the closing of the outline only (dimension text, legends) are not
        mp = cv2.copyMakeBorder(m, 3, 3, 3, 3, cv2.BORDER_CONSTANT, value=0)
        ring = cv2.dilate(mp, np.ones((5, 5), np.uint8)) & (1 - mp)
        bp = bpad[y:y + hh + 6, x:x + w + 6]
        if (bp[ring > 0] > 0).mean() < 0.8:
            continue
        k += 1
        out[lab == i] = k
    return out, k, foot


def main_building(rooms: np.ndarray, n: int, foot: np.ndarray) -> tuple[np.ndarray, int]:
    """Keep the rooms of the building itself: drop spaces in small separate outlines (legend boxes, title blocks)."""
    if n == 0:
        return rooms, n
    m, lab, st, _ = cv2.connectedComponentsWithStats((foot > 0).astype(np.uint8), 8)
    if m <= 2:
        return rooms, n
    big = st[1:, cv2.CC_STAT_AREA].max()
    keep_part = np.zeros(m, bool)
    keep_part[1:] = st[1:, cv2.CC_STAT_AREA] >= 0.2 * big
    remap = np.zeros(n + 1, np.int32)
    k2 = 0
    for k in range(1, n + 1):
        part = np.bincount(lab[rooms == k]).argmax()
        if keep_part[part]:
            k2 += 1
            remap[k] = k2
    return remap[rooms], k2


def drop_islands(rooms: np.ndarray, n: int, door_rooms: set, h: float) -> tuple[np.ndarray, int]:
    """A space with no door that sits wholly inside one other room is furniture or a column drawn in outline."""
    t = 2 * h
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(4 * t) | 1, int(4 * t) | 1))
    drop = set()
    for k in range(1, n + 1):
        if k in door_rooms:
            continue
        m = (rooms == k).astype(np.uint8)
        ring = cv2.dilate(m, kern) & (1 - m)
        around = set(np.unique(rooms[ring > 0]).tolist()) - {0, k}
        if len(around) != 1:
            continue
        j = around.pop()
        cs, _ = cv2.findContours((rooms == j).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        filled = np.zeros_like(m)
        cv2.drawContours(filled, cs, -1, 1, -1)
        if (filled & m).sum() > 0.9 * m.sum() and m.sum() < 0.5 * (rooms == j).sum():
            drop.add(k)
    if not drop:
        return rooms, n
    remap = np.zeros(n + 1, np.int32)
    k2 = 0
    for k in range(1, n + 1):
        if k not in drop:
            k2 += 1
            remap[k] = k2
    return remap[rooms], k2


def entrances(rooms: np.ndarray, barrier: np.ndarray, foot: np.ndarray, h: float) -> list[dict]:
    """Openings in the outer wall: free room edge pixels on the footprint boundary, grouped into segments."""
    edge = cv2.dilate((foot == 0).astype(np.uint8), np.ones((3, 3), np.uint8)) & (foot > 0) & (barrier == 0) & (rooms > 0)
    n, lab, st, cen = cv2.connectedComponentsWithStats(edge.astype(np.uint8), 8)
    out = []
    t = 2 * h
    for i in range(1, n):
        x, y, w, hh, a = st[i]
        L = max(w, hh)
        if L < 1.5 * t:
            continue
        horiz = w >= hh
        out.append({"x": float(x + w / 2), "y": float(y + hh / 2), "w": float(L), "ux": 1.0 if horiz else 0.0, "uy": 0.0 if horiz else 1.0,
                    "rooms": (-1, int(np.bincount(rooms[lab == i]).argmax()))})
    return out


def grow(rooms: np.ndarray, barrier: np.ndarray, h: float) -> np.ndarray:
    """Grow every room into the walls around it up to about the wall centre line."""
    g = rooms.astype(np.float32)
    kern = np.ones((3, 3), np.uint8)
    for _ in range(int(math.ceil(h)) + 1):
        d = cv2.dilate(g, kern)
        g = np.where((g == 0) & (barrier > 0), d, g)
    return g.astype(np.int32)


def _simplify(c: np.ndarray, eps: float) -> list:
    a = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(float)
    return [tuple(p) for p in a]


def square_up(polys: list[list], tol: float) -> list[list]:
    """Snap near-axis edges onto shared x / y lines (clustered over all rooms), then rebuild the corners."""
    vx, hy = [], []
    kinds = []
    for poly in polys:
        ks = []
        for i in range(len(poly)):
            a, b = poly[i], poly[(i + 1) % len(poly)]
            ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) % 180
            L = math.hypot(b[0] - a[0], b[1] - a[1])
            if min(ang, 180 - ang) < 9:
                ks.append(("h", len(hy))); hy.append(((a[1] + b[1]) / 2, L))
            elif abs(ang - 90) < 9:
                ks.append(("v", len(vx))); vx.append(((a[0] + b[0]) / 2, L))
            else:
                ks.append(("d", -1))
        kinds.append(ks)

    def cluster(vals):
        order = sorted(range(len(vals)), key=lambda i: vals[i][0])
        res = [0.0] * len(vals)
        grp: list[int] = []
        def flush():
            if grp:
                tw = sum(vals[i][1] for i in grp)
                m = sum(vals[i][0] * vals[i][1] for i in grp) / tw
                for i in grp:
                    res[i] = m
        for i in order:
            if grp and vals[i][0] - vals[grp[-1]][0] > tol:
                flush(); grp = []
            grp.append(i)
        flush()
        return res

    X, Y = cluster(vx), cluster(hy)
    out = []
    for poly, ks in zip(polys, kinds):
        n = len(poly)
        pts = []
        for i in range(n):
            prev, nxt = ks[i - 1], ks[i]          # edge ending at vertex i, edge starting at vertex i
            x, y = poly[i]
            for kind, j in (prev, nxt):
                if kind == "v":
                    x = X[j]
                elif kind == "h":
                    y = Y[j]
            pts.append((x, y))
        # drop repeats and collinear points
        clean = []
        for p in pts:
            if not clean or math.hypot(p[0] - clean[-1][0], p[1] - clean[-1][1]) > 0.5:
                clean.append(p)
        if len(clean) > 1 and math.hypot(clean[0][0] - clean[-1][0], clean[0][1] - clean[-1][1]) <= 0.5:
            clean.pop()
        changed = True
        while changed and len(clean) > 3:
            changed = False
            for i in range(len(clean)):
                a, b, c = clean[i - 1], clean[i], clean[(i + 1) % len(clean)]
                cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
                if abs(cross) < 1e-6 * max(1.0, math.hypot(c[0] - a[0], c[1] - a[1])) ** 2 or abs(cross) < 0.5:
                    del clean[i]; changed = True; break
        out.append(clean)
    return out


def polygons(grown: np.ndarray, n: int, h: float) -> list[list]:
    polys, ids = [], []
    eps = max(1.5, 0.6 * h)
    for k in range(1, n + 1):
        m = (grown == k).astype(np.uint8)
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cs:
            continue
        c = max(cs, key=cv2.contourArea)
        p = _simplify(c, eps)
        if len(p) >= 3:
            polys.append(p); ids.append(k)
    sq = square_up(polys, max(2.0, 1.5 * h))
    return [(k, p) for k, p in zip(ids, sq) if len(p) >= 3 and cv2.contourArea(np.array(p, np.float32)) > 0]


# ---------------------------------------------------------------- doors and scale

def doors(closures: list[Closure], rooms: np.ndarray, foot: np.ndarray, h: float) -> list[dict]:
    t = 2 * h
    found: list[dict] = []
    for c in closures:
        a, b = c.a, c.b                 # wall faces on both sides of the opening
        w = float(np.linalg.norm(b - a))
        if w < 1.5 * t:
            continue
        sides = _sides(c, rooms, foot, h)
        if 0 in sides or sides[0] == sides[1] or (sides[0] < 0 and sides[1] < 0):
            continue
        mid = (a + b) / 2
        found.append({"x": float(mid[0]), "y": float(mid[1]), "w": w, "ux": float(c.u[0]), "uy": float(c.u[1]), "rooms": tuple(sorted(sides))})
    # both ends of a gap cast rays at each other: merge doors on the same spot
    merged: list[dict] = []
    for d in sorted(found, key=lambda d: -d["w"]):
        if any(math.hypot(d["x"] - m["x"], d["y"] - m["y"]) < max(2 * t, 0.5 * m["w"]) and abs(d["ux"] * m["ux"] + d["uy"] * m["uy"]) > 0.9 for m in merged):
            continue
        merged.append(d)
    return merged


def estimate_width_m(W: int, door_px: list[float], h: float) -> tuple[float, str]:
    widths = sorted(w for w in door_px if w > 0)
    if len(widths) >= 2:
        # lower-middle value: wide openings and double doors outnumber narrow false gaps
        med = widths[int(0.4 * (len(widths) - 1))]
        m = W * DOOR_M / med
        if 4 <= m <= 400:
            return round(m * 2) / 2, f"from {len(widths)} door openings (about {DOOR_M} m each)"
    m = W * WALL_M / max(2 * h, 1)
    return round(min(max(m, 6), 300) * 2) / 2, "from the wall thickness (rough; please check)"


# ---------------------------------------------------------------- room names (OCR)

DIM = re.compile(r"\d+\s*['\"′″xX×]|^\d+([.,]\d+)?$|^\d+\s*(mm|cm|m|ft|sq)\b", re.I)


def ocr(gray: np.ndarray) -> tuple[list[dict], list[dict]]:
    """(text boxes to blank before finding walls, text lines that may name rooms)."""
    exe = shutil.which("tesseract")
    if not exe:
        return [], []
    up = cv2.resize(gray, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC) if max(gray.shape) < 2200 else gray
    f = 1.5 if up is not gray else 1.0
    with tempfile.NamedTemporaryFile(suffix=".png") as tmp:
        cv2.imwrite(tmp.name, up)
        try:
            r = subprocess.run([exe, tmp.name, "stdout", "--psm", "11", "tsv"], capture_output=True, text=True, timeout=60)
        except (subprocess.SubprocessError, OSError):
            return [], []
    words, boxes = [], []
    for line in r.stdout.splitlines()[1:]:
        p = line.split("\t")
        if len(p) < 12 or not p[11].strip():
            continue
        try:
            conf = float(p[10])
        except ValueError:
            continue
        txt = p[11].strip()
        x, y, w, h = (int(v) / f for v in p[6:10])
        wordlike = re.fullmatch(r"[A-Za-z][A-Za-z.'&/()-]{2,}|\d{2,5}[A-Za-z]?|[A-Za-z]{1,3}-?\d{1,4}", txt.strip(".,:;"))
        if conf >= 50 and wordlike and w >= 1.1 * h and h < 0.05 * max(gray.shape):
            boxes.append({"x": x, "y": y, "w": w, "h": h})
        if conf < 55 or DIM.search(txt) or not re.search(r"[A-Za-z]{2,}|^\d{2,4}$", txt):
            continue
        words.append({"k": (p[2], p[3], p[4]), "text": txt, "x": x, "y": y, "w": w, "h": h, "conf": conf})
    lines: dict = {}
    for wd in words:
        lines.setdefault(wd["k"], []).append(wd)
    out = []
    for ws in lines.values():
        ws.sort(key=lambda a: a["x"])
        # two labels side by side can share an OCR line: split where the gap is wide
        groups = [[ws[0]]]
        for a in ws[1:]:
            prev = groups[-1][-1]
            if a["x"] - (prev["x"] + prev["w"]) > 1.2 * max(a["h"], prev["h"]):
                groups.append([a])
            else:
                groups[-1].append(a)
        for g in groups:
            x0 = min(a["x"] for a in g); x1 = max(a["x"] + a["w"] for a in g)
            y0 = min(a["y"] for a in g); y1 = max(a["y"] + a["h"] for a in g)
            out.append({"text": " ".join(a["text"] for a in g), "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2, "h": y1 - y0,
                        "x0": x0, "x1": x1, "conf": min(a["conf"] for a in g)})
    # sparse-text mode often returns each word as its own line: join words on one baseline that sit close together
    out.sort(key=lambda a: (a["cy"], a["x0"]))
    joined: list[dict] = []
    for ln in sorted(out, key=lambda a: a["x0"]):
        for j in joined:
            hh = max(j["h"], ln["h"])
            if abs(j["cy"] - ln["cy"]) < 0.4 * hh and abs(j["h"] - ln["h"]) < 0.4 * hh and 0 <= ln["x0"] - j["x1"] < 2.2 * hh:
                gap = ln["x0"] - j["x1"]
                j["text"] += (" / " if gap > 1.4 * hh else " ") + ln["text"]
                j["x1"] = ln["x1"]; j["cx"] = (j["x0"] + j["x1"]) / 2; j["conf"] = min(j["conf"], ln["conf"])
                break
        else:
            joined.append(dict(ln))
    out = joined
    return boxes, out


def _nice(text: str) -> str:
    t = re.sub(r"[^\w&/().#' -]+", "", text).strip(" -.")
    return t.title() if t.isupper() and len(t) > 3 else t


ROOM_WORDS = re.compile(r"\b(room|bed|bedroom|bath|bathroom|wc|toilet|shower|kitchen|kitchenette|living|lounge|dining|family|hall|hallway|lobby|"
                        r"foyer|entry|entrance|corridor|passage|stair|stairs|lift|elevator|store|storage|closet|wardrobe|pantry|laundry|utility|"
                        r"garage|carport|balcony|terrace|deck|patio|porch|veranda|study|office|den|library|meeting|conference|board|training|"
                        r"class|classroom|lab|server|hub|electrical|mechanical|plant|gym|pray|prayer|ablution|cafeteria|canteen|cafe|break|"
                        r"reception|waiting|nursery|guest|master|kids|play|media|theater|theatre|workspace|work|zone|area|suite|ensuite|"
                        r"powder|mud|boiler|a/c|ac|outdoor|yard|garden|medical|clinic|first aid|maternity|locker|changing|dressing|"
                        r"server|it|copy|print|mail|archive|security|janitor|cleaner|shop|retail|bar|restaurant|ward|icu|nurse)\b", re.I)


def _plausible(ln: dict) -> int:
    """2 = has a room word, 1 = clean confident words, 0 = noise (names, codes, fragments)."""
    t = ln["text"]
    if ROOM_WORDS.search(t):
        return 2
    words = t.split()
    if "_" in t or "@" in t or "(" in t:
        return 0
    if ln.get("conf", 0) >= 80 and all(len(re.sub(r"[^A-Za-z]", "", w)) >= 3 for w in words) and re.search(r"[aeiouyAEIOUY]", t):
        return 1
    return 0


def name_rooms(rooms: np.ndarray, lines: list[dict]) -> dict[int, tuple[str, str]]:
    H, W = rooms.shape
    per: dict[int, list] = {}
    for ln in lines:
        xi, yi = int(ln["cx"]), int(ln["cy"])
        if 0 <= xi < W and 0 <= yi < H and rooms[yi, xi] > 0 and _plausible(ln):
            per.setdefault(int(rooms[yi, xi]), []).append(ln)
    names = {}
    for k, ls in per.items():
        # a room word beats other text; then the biggest text (the name, not a note)
        ls.sort(key=lambda a: (-_plausible(a), -a["h"], a["cy"]))
        top = ls[0]
        same = sorted([l for l in ls if _plausible(l) and abs(l["h"] - top["h"]) < 0.35 * top["h"] and abs(l["cx"] - top["cx"]) < 4 * top["h"]
                       and 0 < abs(l["cy"] - top["cy"]) < 2.2 * top["h"]] + [top], key=lambda a: a["cy"])
        label = " ".join(l["text"] for l in same[:2])
        label = re.sub(r"\s+", " ", label).strip()[:60]
        if re.search(r"[A-Za-z]{2,}", label):
            names[k] = (_nice(label)[:40] or "Room", label)
    return names


# ---------------------------------------------------------------- entry point

def blank_text(dark: np.ndarray, boxes: list[dict]) -> np.ndarray:
    """Erase printed text so bold labels are not taken for walls. A box is only text if the ring around it is
    mostly blank: OCR also "reads" words in wall hatching, and those must stay."""
    out = dark.copy()
    H, W = dark.shape
    for b in boxes:
        pad = 0.15 * b["h"]
        x0, y0 = max(0, int(b["x"] - pad)), max(0, int(b["y"] - pad))
        x1, y1 = min(W, int(b["x"] + b["w"] + pad) + 1), min(H, int(b["y"] + b["h"] + pad) + 1)
        r = max(3, int(0.5 * b["h"]))
        X0, Y0, X1, Y1 = max(0, x0 - r), max(0, y0 - r), min(W, x1 + r), min(H, y1 + r)
        ring = (dark[Y0:Y1, X0:X1] > 0).sum() - (dark[y0:y1, x0:x1] > 0).sum()
        ring_area = (X1 - X0) * (Y1 - Y0) - (x1 - x0) * (y1 - y0)
        if ring_area > 0 and ring / ring_area < 0.3:
            out[y0:y1, x0:x1] = 0
    return out


def _attempt(gray: np.ndarray, boxes: list[dict], close: int, thin: bool = False) -> dict:
    dark = blank_text(ink(gray, close), boxes)
    h = 1.5 if thin else wall_half_thickness(dark)
    walls = wall_mask(dark, h)
    barrier, closures = close_gaps(walls, h)
    rooms, n, foot = room_labels(barrier, h)
    # a ray that cuts off a sliver too small to be a room crossed a room instead of closing a door: drop it
    keep = [c for c in closures if 0 not in _sides(c, rooms, foot, h)]
    if len(keep) < len(closures):
        closures = keep
        barrier = _draw_closures(walls, closures, h)
        rooms, n, foot = room_labels(barrier, h)
    return {"h": h, "barrier": barrier, "closures": closures, "rooms": rooms, "n": n, "foot": foot}


def label_split(rooms: np.ndarray, lines: list[dict]) -> float:
    """Share of the printed room names that land in a room of their own (0..1)."""
    H, W = rooms.shape
    hits = []
    for ln in lines:
        if len(re.sub(r"[^A-Za-z]", "", ln["text"])) < 3:
            continue
        xi, yi = int(ln["cx"]), int(ln["cy"])
        if 0 <= xi < W and 0 <= yi < H:
            hits.append(int(rooms[yi, xi]))
    inside = [k for k in hits if k > 0]
    if len(inside) < 3:
        return 1.0      # too few names to judge: neutral
    return len(set(inside)) / len(inside)


def score(rooms: np.ndarray, n: int) -> float:
    """How plausible a room split is: rooms fill their footprint and are mostly rectangular."""
    if n == 0:
        return 0.0
    rect, total = 0.0, 0
    for k in range(1, n + 1):
        m = (rooms == k).astype(np.uint8)
        a = int(m.sum())
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        (_, _), (w, h), _ = cv2.minAreaRect(max(cs, key=cv2.contourArea))
        rect += a * min(1.0, a / max(w * h, 1))
        total += a
    ys, xs = np.nonzero(rooms)
    foot = (xs.max() - xs.min() + 1) * (ys.max() - ys.min() + 1)
    return (rect / total) * min(1.0, total / foot / 0.6) * min(1.0, n / 3)


def analyze(img: np.ndarray, use_ocr: bool = True) -> dict:
    H0, W0 = img.shape[:2]
    # work at 1200-1600 px: small scans are upscaled so thin walls and small text survive thresholding
    s = min(MAX_SIDE / max(H0, W0), max(1.0, 1200 / max(H0, W0)))
    if s != 1:
        img = cv2.resize(img, (round(W0 * s), round(H0 * s)), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    H, W = gray.shape
    corners = sheet_corners(gray)
    if corners:
        return {"rooms": [], "doors": [], "photo_corners": corners, "width_m": None, "scale_note": None, "wall_px": None}
    gray = clear_background(gray)
    boxes, lines = ocr(gray) if use_ocr else ([], [])
    tries = [_attempt(gray, boxes, c) for c in (1, 7, 13)] + [_attempt(gray, boxes, 1, thin=True)]
    for a in tries:
        a["rooms"], a["n"] = main_building(a["rooms"], a["n"], a["foot"])
        # plausible shapes, plus printed names landing in rooms of their own when the plan has names
        a["score"] = score(a["rooms"], a["n"]) * (0.3 + 0.7 * label_split(a["rooms"], lines))
    # near-ties go to the least processing (the order above): heavier closing also bridges real gaps
    top = max(a["score"] for a in tries)
    best = next(a for a in tries if a["score"] >= top - 0.02)
    h, barrier, closures, rooms, n = best["h"], best["barrier"], best["closures"], best["rooms"], best["n"]
    if n == 0:
        return {"rooms": [], "doors": [], "photo_corners": None, "width_m": None, "scale_note": None, "wall_px": 2 * h / W}
    foot = best["foot"]
    grown = grow(rooms, barrier, h)
    ds = doors(closures, grown, foot, h) + entrances(rooms, barrier, foot, h)
    with_door = {r for d in ds for r in d["rooms"] if r > 0}
    rooms2, n2 = drop_islands(rooms, n, with_door, h)
    if n2 != n:
        rooms, n = rooms2, n2
        grown = grow(rooms, barrier, h)
    names = name_rooms(rooms, lines)
    polys = polygons(grown, n, h)
    # stable order: top to bottom, left to right
    polys.sort(key=lambda kp: (round(min(p[1] for p in kp[1]) / (0.05 * H)), min(p[0] for p in kp[1])))
    out_rooms = []
    unnamed = 0
    for k, p in polys:
        nm = names.get(k)
        if not nm:
            unnamed += 1
            nm = (f"Room {unnamed}", "")
        r = {"name": nm[0], "points": [[round(x / W, 4), round(y / H, 4)] for x, y in p], "id": k}
        if nm[1]:
            r["label"] = nm[1]
        out_rooms.append(r)
    width_m, note = estimate_width_m(W, [d["w"] for d in ds], h)
    out_doors = [{"kind": "door", "fx": round(d["x"] / W, 5), "fy": round(d["y"] / H, 5), "fw": round(d["w"] / W, 5),
                  "fd": round(max(2 * h, 2) / W, 5), "rot": round(-math.atan2(d["uy"], d["ux"]), 4)} for d in ds]
    return {"rooms": out_rooms, "doors": out_doors, "photo_corners": None, "width_m": width_m, "scale_note": note, "wall_px": round(2 * h / W, 5),
            "_labels": rooms, "_barrier": barrier, "_shape": (H, W)}
