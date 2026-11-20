extends Node
## --walk=<dir>: walk-through checks on the platform's floor (platform running).
## Every room can be reached on foot; routes into several rooms arrive without passing through a wall;
## walking straight at walls never goes through them; leaving the walk restores the cut-away map.
## Writes result.txt (PASS/FAIL lines) and screenshots.

var out := "/tmp/walk"
var lines: Array = []
var failed := 0


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--walk="):
			out = a.substr(7)
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


func _crosses(a: Vector2, b: Vector2, pieces: Array) -> bool:
	if a.distance_to(b) < 1e-5:
		return false
	for s in pieces:
		if Geometry2D.segment_intersects_segment(a, b, s[0], s[1]) != null:
			return true
	return false


## Runs the walker without rendering until its route is done; false if it ever stepped through a wall.
func _walk_route(w: Walker, pieces: Array, max_steps := 3000) -> bool:
	var clean := true
	for i in max_steps:
		var before := w.p
		w._process(0.05)
		if _crosses(before, w.p, pieces):
			clean = false
		if w._path.is_empty():
			break
	return clean


func _run() -> void:
	var main := get_parent()
	for i in 200:
		if main.world != null and Store.rooms.size() > 3 and Store.layout_version != 0:
			break
		await _wait(0.25)
	await _wait(2.0)
	var map_h: float = Store.wall_height
	var map_doors := Store.furniture.filter(func(f): return f.get("kind", "") == "door").size()
	Bridge.handle({"type": "walk", "action": "start"})
	await _wait(2.0)
	var w: Walker = main.walker
	_check(w != null and Store.walk, "walk mode starts")
	if w == null:
		_finish()
		return
	_check(absf(Store.wall_height - main.WALK_HEIGHT) < 0.01, "walls are full height while walking (%.2f m)" % Store.wall_height)
	var auto := Store.furniture.filter(func(f): return f.get("auto", false)).size()
	lines.append("INFO  %d doors on the plan, %d doorways added for closed rooms" % [map_doors, auto])
	var pieces: Array = main.floor_builder.wall_pieces
	_check(w.nav.is_free(w.p), "the walker starts on walkable floor (%s, in %s)" % [w.p, w.room_key])
	await _shot("w0_start")
	# every room is reachable on foot
	var unreachable: Array = []
	for r in Store.rooms:
		if w.nav.room_target(r, w.p) == Vector2.INF:
			unreachable.append(r.key)
	for k in unreachable:
		var poly := PlanGeo.room_poly(Store.room(k))
		for f in Store.furniture:
			if f.get("kind", "") != "door":
				continue
			var c := Vector2(float(f.x), float(f.z))
			var touching := false
			for i in poly.size():
				if c.distance_to(Geometry2D.get_closest_point_to_segment(c, poly[i], poly[(i + 1) % poly.size()])) < 0.3:
					touching = true
			if touching:
				var nn := Vector2(sin(float(f.rot)), cos(float(f.rot)))
				print("unreachable %s: door at at %s w=%.2f auto=%s free c=%s +n=%s -n=%s rooms +n=%s -n=%s" % [k, c, float(f.w), f.get("auto", false), w.nav.is_free(c), w.nav.is_free(c + nn * 0.35), w.nav.is_free(c - nn * 0.35), Store.room_at(c + nn * 0.35).get("key", "-"), Store.room_at(c - nn * 0.35).get("key", "-")])
	_check(unreachable.is_empty(), "all %d rooms reachable on foot%s" % [Store.rooms.size(), "" if unreachable.is_empty() else " (not: %s)" % ", ".join(unreachable)])
	# routes into rooms go through doorways, never through walls
	var keys: Array = Store.rooms.map(func(r): return r.key)
	var picks: Array = []
	for k in ["training-room-403-sajek", "medical-room", "gym-room", "male-toilet", "utility-room", "cafeteria-208-seats"]:
		if keys.has(k):
			picks.append(k)
	while picks.size() < 5 and picks.size() < keys.size():
		picks.append(keys[picks.size() * 3 % keys.size()])
	var n := 0
	for k in picks:
		var ok: bool = w.go_to_room(k)
		var clean := _walk_route(w, pieces)
		w._track_room()
		_check(ok and clean and w.room_key == k, "walks into %s through a doorway (ended in %s, wall crossed: %s)" % [k, w.room_key, not clean])
		w._apply()
		await _wait(0.3)
		await _shot("w%d_%s" % [1 + n, k])
		n += 1
	# walking straight ahead in 12 directions for 15 m never passes through a wall
	var through := 0
	for d in 12:
		w.yaw = TAU * d / 12.0
		w._keys[KEY_W] = true
		for i in 300:
			var before := w.p
			w._process(0.05)
			if _crosses(before, w.p, pieces):
				through += 1
		w._keys[KEY_W] = false
	_check(through == 0, "straight walks at walls stop at the wall (%d crossings)" % through)
	# a click on the floor walks there
	w.pitch = deg_to_rad(-25.0)
	w._apply()
	var vp := get_viewport().get_visible_rect().size
	var hit = w.floor_at(Vector2(vp.x / 2, vp.y * 0.7))
	_check(hit != null, "the floor in front can be picked")
	await _shot("w8_look")
	Bridge.handle({"type": "walk", "action": "stop"})
	await _wait(2.0)
	_check(main.walker == null and not Store.walk, "walk mode ends")
	_check(absf(Store.wall_height - map_h) < 0.01, "map walls are back to %.2f m" % map_h)
	_check(Store.furniture.filter(func(f): return f.get("auto", false)).is_empty(), "added doorways are gone on the map")
	await _shot("w9_back")
	_finish()


func _finish() -> void:
	lines.append("%d failed" % failed)
	var f := FileAccess.open(out + "/result.txt", FileAccess.WRITE)
	f.store_string("\n".join(lines) + "\n")
	f.close()
	print("\n".join(lines))
	get_tree().quit()
