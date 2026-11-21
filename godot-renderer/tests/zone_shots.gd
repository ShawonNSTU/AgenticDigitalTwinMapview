extends Node
## --zone-shots=<dir>: eye-level views of the SmartThings Experience Zone from where its reference photos were taken
## (outside the glass door, the door wall, the desk corner, the left wall, the window wall, the TV wall), an overview,
## and, when a device changes state while it runs (e.g. tools/smartthings_mock.py POST /_set), three frames of the
## change. Platform running. Views are worked out from the room's door, so they follow the layout.

var out := "/tmp/zone"
const ROOM := "smartthings-experience-zone"


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--zone-shots="):
			out = a.substr(13)
	DirAccess.make_dir_recursive_absolute(out)
	_run.call_deferred()


func _shot(name: String) -> void:
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png(out + "/" + name + ".png")
	print("shot ", name)


## Room frame as web/lib/sim/stzone.ts lays the zone out: s along the door wall from the door's corner, q into the room.
var o := Vector2.ZERO
var u := Vector2.ZERO
var n := Vector2.ZERO
var L := 0.0
var D := 0.0


func _frame() -> bool:
	var r: Dictionary = Store.room(ROOM)
	if r.is_empty():
		return false
	var poly := PlanGeo.room_poly(r)
	var lo := Vector2(INF, INF)
	var hi := Vector2(-INF, -INF)
	for p in poly:
		lo = lo.min(p)
		hi = hi.max(p)
	var door := {}
	for f in Store.furniture:
		if str(f.get("kind", "")) == "door" and float(f.x) > lo.x - 0.3 and float(f.x) < hi.x + 0.3 and float(f.z) > lo.y - 0.3 and float(f.z) < hi.y + 0.3:
			door = f
	if door.is_empty():
		return false
	var dp := Vector2(float(door.x), float(door.z))
	var walls := [[Vector2(hi.x, lo.y), Vector2(hi.x, hi.y), Vector2(-1, 0)], [Vector2(lo.x, lo.y), Vector2(lo.x, hi.y), Vector2(1, 0)],
		[Vector2(lo.x, hi.y), Vector2(hi.x, hi.y), Vector2(0, -1)], [Vector2(lo.x, lo.y), Vector2(hi.x, lo.y), Vector2(0, 1)]]
	walls.sort_custom(func(a, b): return absf((dp - a[0]).dot(a[2])) < absf((dp - b[0]).dot(b[2])))
	var w: Array = walls[0]
	n = w[2]
	var right := Vector2(-n.y, n.x)
	var c0: Vector2 = w[0] if (w[0] - dp).dot(right) > (w[1] - dp).dot(right) else w[1]
	var c1: Vector2 = w[1] if c0 == w[0] else w[0]
	o = c0
	L = c0.distance_to(c1)
	u = (c1 - c0) / L
	D = (hi.x - lo.x) if absf(n.x) > 0.5 else (hi.y - lo.y)
	print("zone frame: door ", dp, " corner ", o, " u ", u, " n ", n, " L ", L, " D ", D)
	return true


func at(s: float, q: float) -> Vector2:
	return o + u * s + n * q


## CPU-side cost (meaningful even on a software renderer): script time per frame, draw calls, objects drawn, and
## how many device effects still run every frame.
func _perf(tag: String) -> void:
	var fx := 0
	var busy := 0
	for n in get_tree().root.find_children("*", "DeviceFx", true, false):
		fx += 1
		if n.is_processing():
			busy += 1
	var lights := get_tree().root.find_children("*", "Light3D", true, false).filter(func(l): return l.visible).size()
	if tag == "0_overview" or tag == "2_door_wall":
		var by := {}
		for m in get_tree().root.find_children("*", "GeometryInstance3D", true, false):
			var k: String = str(m.get_parent().name) + "/" + m.get_class()
			by[k] = by.get(k, 0) + 1
		var keys := by.keys()
		keys.sort_custom(func(a, b): return by[a] > by[b])
		for k in keys.slice(0, 12):
			print("  geom ", k, " ", by[k])
	print("perf %s process_ms %.2f draw_calls %d objects %d fx_busy %d/%d lights_on %d" % [tag, Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
		Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME), Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME), busy, fx, lights])


func _view(main: Node, from: Vector2, to: Vector2, pitch_deg := -4.0) -> void:
	var w = main.walker
	w.p = from
	var d := to - from
	w.yaw = atan2(-d.x, -d.y)
	w.pitch = deg_to_rad(pitch_deg)
	w._intro = 0.0
	w._look_goal = null
	w._apply()


func _run() -> void:
	var main := get_parent()
	for i in 240:
		if main.world != null and Store.layout_version > 0 and Store.live.size() > 0:
			break
		await get_tree().create_timer(0.25).timeout
	await get_tree().create_timer(3.0).timeout
	if not _frame():
		print("ZONE SHOTS: no zone")
		get_tree().quit(1)
		return
	var r: Dictionary = Store.room(ROOM)
	var c := PlanGeo.interior_point(PlanGeo.room_poly(r))
	main.rig.fly_to(Vector3(c.x, 0, c.y), 8.5, deg_to_rad(-55.0), atan2(-n.x, -n.y) + deg_to_rad(20.0), 0.1)
	await get_tree().create_timer(3.0).timeout
	await _shot("0_overview")
	_perf("0_overview")
	Bridge.handle({"type": "walk", "action": "start", "room": ROOM})
	await get_tree().create_timer(5.0).timeout
	main.walker.set_process(false)   # hold the views still
	var views := [
		["1_entry", at(0.55, -1.1), at(0.9, D), -6.0],        # from the corridor, through the open glass door
		["2_door_wall", at(2.9, 3.0), at(1.8, 0.0), -4.0],    # photo 1: door, lamp, purifier, desk under the wall TV
		["3_desk_corner", at(2.0, 2.4), at(L, 0.0), -6.0],    # photo 2: L-desk corner, desk lamp, flowers
		["4_left_wall", at(1.6, 2.0), at(L, D * 0.8), -2.0],  # photo 3: desk return, print, bookcase corner
		["5_window_wall", at(2.4, 1.0), at(2.1, D), 4.0],     # photo 8: window, roller shade, Light 4, lamps
		["6_tv_wall", at(2.6, 2.7), at(0.0, 1.2), 2.0],       # photo 9: main TV, Light 5, the door beside it
		["7_tv_wall_far", at(1.2, 0.8), at(0.25, D), 10.0],   # photo 7: Light 1 behind the TV, Light 2 above
	]
	for v in views:
		_view(main, v[1], v[2], v[3])
		await get_tree().create_timer(1.5).timeout
		await _shot(v[0])
		_perf(v[0])
	# a state change while watching the window wall (the caller changes devices through the SmartThings mock)
	_view(main, at(2.4, 1.0), at(2.1, D), 4.0)
	var zone_live := func() -> String:
		var parts := []
		for d in Store.devices:
			if str(d.get("room", "")) == ROOM and ["light", "blinds", "plug"].has(str(d.get("type", ""))):
				parts.append(JSON.stringify(Store.live.get(d.id, {})))
		return "|".join(parts)
	var before: String = zone_live.call()
	var waited := 0.0
	while zone_live.call() == before and waited < 40.0:
		await get_tree().create_timer(0.2).timeout
		waited += 0.2
	if waited < 40.0:
		await get_tree().create_timer(0.25).timeout
		await _shot("8_change_a")
		await get_tree().create_timer(0.5).timeout
		await _shot("8_change_b")
		await get_tree().create_timer(3.5).timeout
		await _shot("8_change_c")
	print("FPS ", Engine.get_frames_per_second())
	print("ZONE SHOTS OK")
	get_tree().quit()
