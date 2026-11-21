"""Recognise floor plans the platform already has a hand-checked model of.

An upload of such a floor is built from that model instead of being read from scratch, so it renders exactly like
the reference. Two checks, either is enough:

1. Image match: ORB features of the upload against the reference images (the straightened sheet and the original
   photo), with a RANSAC homography. Works for scans, crops, rotations and photos at an angle. The reference
   images are private and only present where they were installed (web/public/presets).
2. Text match: the room names the plan reader prints out, against the floor's room names (public, sanitised).
   Used when the reference images are not installed.
"""
from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
PRESET_DIR = Path(os.getenv("KNOWN_PLANS_DIR", ROOT / "web" / "public" / "presets"))
PUBLIC_DIR = Path(os.getenv("KNOWN_PLANS_PUBLIC_DIR", ROOT / "web" / "lib" / "presets"))

# id -> reference images (private) and the words that only this floor prints
KNOWN = {
    "samsung-rnd-4f": {
        "images": ["samsung-rnd-4f.jpg", "samsung-rnd-4f-photo.jpg"],
        "distinct": ["sajek", "saint martin", "maternity", "smartthing", "smart thing", "experience zone", "zone d", "4f", "4th fl"],
    },
}
SIDE = 1200          # match at this size: fast (about 0.3 s) and still detailed
MIN_INLIERS = 120    # the photo of the 4F sheet gives about 1000; unrelated plans give under 40
MIN_RATIO = 0.25     # share of good matches that agree on one homography


def _small(gray: np.ndarray) -> np.ndarray:
    s = SIDE / max(gray.shape[:2])
    return cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else gray


def _features(gray: np.ndarray):
    return cv2.ORB_create(4000).detectAndCompute(_small(gray), None)


@lru_cache(maxsize=8)
def _reference(path: str):
    g = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    return None if g is None else _features(g)


def image_match(img: np.ndarray) -> str | None:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    k, d = _features(gray)
    if d is None or len(k) < 50:
        return None
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    for pid, spec in KNOWN.items():
        for name in spec["images"]:
            p = PRESET_DIR / name
            if not p.exists():
                continue
            ref = _reference(str(p))
            if ref is None or ref[1] is None:
                continue
            kr, dr = ref
            pairs = bf.knnMatch(d, dr, k=2)
            good = [m[0] for m in pairs if len(m) == 2 and m[0].distance < 0.75 * m[1].distance]
            if len(good) < MIN_INLIERS:
                continue
            src = np.float32([k[m.queryIdx].pt for m in good])
            dst = np.float32([kr[m.trainIdx].pt for m in good])
            Hm, mask = cv2.findHomography(src, dst, cv2.RANSAC, 6.0)
            if Hm is None or mask is None:
                continue
            n = int(mask.sum())
            # a real match spreads over the sheet; repeated hatching collapses onto one spot of the reference
            inl = dst[mask.ravel() > 0]
            spread = (inl.max(0) - inl.min(0)) / np.float32([SIDE, SIDE])
            if n >= MIN_INLIERS and n >= MIN_RATIO * len(good) and spread.min() > 0.15 and abs(np.linalg.det(Hm[:2, :2])) > 0.02:
                return pid
    return None


@lru_cache(maxsize=4)
def _room_words(pid: str) -> tuple[str, ...]:
    p = PUBLIC_DIR / f"{pid}.json"
    if not p.exists():
        return ()
    names = [r["name"] for r in json.loads(p.read_text())["rooms"]]
    words = set()
    for n in names:
        for w in re.findall(r"[a-z/]{3,}", n.lower()):
            if w not in {"room", "area", "stair", "and", "the"}:
                words.add(w)
    return tuple(sorted(words))


def text_match(texts: list[str]) -> str | None:
    """texts: every line of text read on the plan."""
    blob = " " + " ".join(re.sub(r"[^a-z0-9/ ]+", " ", t.lower()) for t in texts) + " "
    blob = re.sub(r"\s+", " ", blob)
    for pid, spec in KNOWN.items():
        # whole words; long names may also run together ("smartthings", "experiencezone")
        distinct = sum(1 for w in spec["distinct"] if re.search(rf"\b{re.escape(w)}\b", blob) or (len(w) > 6 and w.replace(" ", "") in blob.replace(" ", "")))
        common = sum(1 for w in _room_words(pid) if f" {w}" in blob)
        # one floor-specific word with many of its room words, or two with fewer
        if (distinct >= 1 and common >= 6) or (distinct >= 2 and common >= 4):
            return pid
    return None
