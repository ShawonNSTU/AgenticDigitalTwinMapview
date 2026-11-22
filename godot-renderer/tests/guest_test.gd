extends Node
## --guest=<token> --guest-check=<dir>: opens the floor as a guest (platform running, pass created first).
## Checks: only the guest room's devices arrive; the walk starts outside the room and reaches it through
## doorways without crossing walls; doors of rooms off the way stay shut; once there, the guest can't
## walk out. Writes result.txt and screenshots.

var out := "/tmp/guest"
var lines: Array = []
var failed := 0


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--guest-check="):
			out = a.substr(14)
	DirAccess.make_dir_recursive_absolute(out)
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	lines.append(("PASS  " if ok else "FAIL  ") + what)
	print(lines[-1])
	if not ok:
		failed += 1


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func _shot(name: String) -> void:
	if DisplayServer.get_name() == "headless":
		return
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png(out + "/" + name + ".png")


func _run() -> void:
	var main := get_parent()
	for i in 240:
		if main.walker != null:
			break
		await _wait(0.25)
	var w: Walker = main.walker
	_check(w != null, "the guest walk starts on its own")
	if w == null:
		_finish()
		return
	var room: String = Store.guest.get("room", "")
	lines.append("INFO  guest room %s; open rooms on the way: %s" % [room, ", ".join(Store.guest_allowed.keys())])
	_check(Store.devices.all(func(d): return d.room == room), "only the guest room's devices are loaded (%d)" % Store.devices.size())
	var start_room: String = w.room_key
	_check(start_room != room, "the walk starts outside the room (in %s)" % start_room)
	var doors := Store.furniture.filter(func(f): return f.get("kind", "") == "door")
	var shut := doors.filter(func(f): return not Store.door_open(f)).size()
	_check(shut > 0, "doors of rooms off the way stay shut (%d of %d)" % [shut, doors.size()])
	await _wait(Walker.INTRO + 0.6)
	await _shot("g0_start")
	var pieces: Array = main.floor_builder.wall_pieces
	var crossed := 0
	var got := {"arrived": false}  # lambdas capture locals by value: use a dictionary
	w.arrived.connect(func(): got.arrived = true)
	for i in 4000:
		var before := w.p
		w._process(0.05)
		for s in pieces:
			if Geometry2D.segment_intersects_segment(before, w.p, s[0], s[1]) != null:
				crossed += 1
		if got.arrived:
			break
		if i % 400 == 0:
			await get_tree().process_frame
	w._track_room()
	_check(got.arrived and w.room_key == room, "the guest walks into their room (ended in %s)" % w.room_key)
	_check(crossed == 0, "the way there never crosses a wall (%d)" % crossed)
	main._guest_arrived()
	print("arrived at ", w.p, " room ", w.room_key, " poly ", PlanGeo.room_poly(Store.room(room)))
	w._apply()
	await _wait(0.4)
	await _shot("g1_arrived")
	# let the arrival settle (the step to the whole-room view), then tap two spots on the room's floor: the guest
	# must stay where they tapped, not be walked back to the arrival spot
	for i in 200:
		w._process(0.05)
	await _wait(0.3)
	await _shot("g2_settled")   # the view a guest gets of their room
	w.overview(true)
	for i in 40:
		w._process(0.05)
	await _wait(0.3)
	await _shot("g3_whole_room")
	w.overview(false)
	for i in 40:
		w._process(0.05)
	var poly := PlanGeo.room_poly(Store.room(room))
	var spots: Array = []
	for q in poly:
		var c := PlanGeo.interior_point(poly)
		var s := w.nav.nearest_free(c.lerp(q, 0.6), 10)
		if Geometry2D.is_point_in_polygon(s, poly) and w.nav.is_free(s) and spots.size() < 2 and (spots.is_empty() or spots[0].distance_to(s) > 1.2):
			spots.append(s)
	var strayed := 0
	for s in spots:
		w.go_to(s)
		for i in 300:   # 15 s: there, and a while after
			w._process(0.05)
		if w.p.distance_to(s) > 0.6:
			strayed += 1
			print("tapped ", s, " but stands at ", w.p)
	_check(spots.size() == 2 and strayed == 0, "a tap on the room's floor takes the guest there and they stay (%d of %d moved away)" % [strayed, spots.size()])
	# try to leave: walk straight in 12 directions for 15 m
	var left := 0
	for d in 12:
		w.yaw = TAU * d / 12.0
		w._keys[KEY_W] = true
		for i in 300:
			w._process(0.05)
			if Store.room_at(w.p).get("key", "") != room:
				if left == 0:
					print("outside at ", w.p, " in ", Store.room_at(w.p).get("key", "-"), " dir ", d, " free ", w.nav.is_free(w.p))
				left += 1
		w._keys[KEY_W] = false
	_check(left == 0, "the guest can't walk out of the room (%d steps outside)" % left)
	_check(not w.go_to_room(start_room), "walking to another room is refused")
	Bridge.handle({"type": "walk", "action": "stop"})
	await _wait(0.5)
	_check(main.walker != null, "a guest can't leave the walk for the map")
	_finish()


func _finish() -> void:
	lines.append("%d failed" % failed)
	var f := FileAccess.open(out + "/result.txt", FileAccess.WRITE)
	f.store_string("\n".join(lines) + "\n")
	f.close()
	print("\n".join(lines))
	get_tree().quit()
