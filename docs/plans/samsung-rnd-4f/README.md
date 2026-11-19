# Reference floor: Samsung Bangladesh R&D Center, 4th floor (private files)

The pipeline is verified end to end on a real floor: a phone photo of the printed 4th-floor sheet, straightened,
traced into 25 rooms (including a slanted outer wall) with the CCTV cameras at their marked positions, rendered,
opened as device twins and queried through the agent.

The drawing shows CCTV camera positions and IDs and staff names, so its files are **not committed** to this public
repository. To use them, copy the private bundle into place:

```
docs/plans/samsung-rnd-4f/plan.jpg      straightened photo, cropped to the drawing
docs/plans/samsung-rnd-4f/trace.py      room outlines, camera positions, assumed fit-out (plan pixels) → writes the preset
web/public/presets/samsung-rnd-4f.json  editor preset ("4F plan (traced)")
web/public/presets/samsung-rnd-4f.jpg   plan image for the preset
web/public/presets/samsung-rnd-4f-photo.jpg  original photo ("4F photo (straighten)")
```

How it was traced: homography from four straight wall lines; scale from the 19179 mm dimension on the Male Pray Room
(28.0 mm/px, cross-checked against the 1800 mm corridor at 1.88 m); cameras found as red symbols by colour detection,
with counts checked against the sheet's legend. Devices not on the sheet (ACs, lights, sensors) are an assumed fit-out
and are named "(position assumed)".

Interiors (428 items) come from the drawing: 23 columns and 207 cafeteria + 6 small-cafeteria seats detected
automatically (the facility table says 208 and 6), tables derived from seat-row spacing, the 56 + 32 classroom seats
and desks from the drawn grid, and the gym, pods, sanitary ware, stairs and room furniture read off the sheet.
