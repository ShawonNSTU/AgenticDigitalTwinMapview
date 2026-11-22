

def test_columns_found_as_solid_blocks_not_walls_or_text():
    """Filled squares are structural columns, also where they sit on a wall; walls and text are not."""
    import cv2
    import numpy as np
    from app.floorplan import plan_cv
    im = np.full((1000, 1500), 255, np.uint8)
    for a, b in [((50, 50), (1450, 50)), ((1450, 50), (1450, 950)), ((1450, 950), (50, 950)), ((50, 950), (50, 50)), ((750, 50), (750, 950))]:
        cv2.line(im, a, b, 0, 10)
    for cx, cy in [(400, 300), (1100, 300), (400, 700), (1100, 700), (750, 500)]:
        cv2.rectangle(im, (cx - 20, cy - 20), (cx + 20, cy + 20), 0, -1)
    cv2.putText(im, "MEETING ROOM", (150, 150), cv2.FONT_HERSHEY_SIMPLEX, 1.2, 0, 3)
    cols = plan_cv.columns(im, 5.0, 30.0)   # 30 m wide: 50 px a metre, the columns 0.8 m
    assert len(cols) == 5
    assert all(abs(c["fw"] * 30 - 0.8) < 0.15 for c in cols)
    assert not plan_cv.columns(im, 5.0, None)   # no scale, no guessing
