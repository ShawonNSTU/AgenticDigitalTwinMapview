extends Node
## --routes=<room key>: for every possible starting point (stairs, lifts, doors to the outside), the walking
## route to the room: its length and the rooms it passes through. Used to pick a sensible start for guests.

func _ready() -> void:
	_run.call_deferred()


func _run() -> void:
	var main := get_parent()
	var room := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--routes="):
			room = a.get_slice("=", 1)
	for i in 240:  # wait for the platform's floor (not the built-in demo)
		if main.world != null and (not Store.room(room).is_empty() or (room == "*" and Store.rooms.size() > 5)):
			break
		await get_tree().create_timer(0.25).timeout
	await get_tree().create_timer(2.0).timeout
	if room == "*":  # every room: the walk from the lift lobby (where guests arrive), or NO WAY IN
		Store.furniture = Store.furniture + WalkNav.auto_doors(Store.rooms, Store.furniture)
		for f in Store.furniture:
			if f.get("kind", "") == "door" and f.get("auto", false):
				print("AUTO DOOR (the plan gives no way in) ", Store.room_at(Vector2(float(f.x), float(f.z)) + Vector2(sin(float(f.rot)), cos(float(f.rot))) * 0.5).get("name", "?"), " / ", Store.room_at(Vector2(float(f.x), float(f.z)) - Vector2(sin(float(f.rot)), cos(float(f.rot))) * 0.5).get("name", "?"))
		var nv := WalkNav.new()
		nv.build(main.floor_builder.wall_pieces, main.floor_builder.lintels)
		var lobby: Dictionary = Store.room("lift-lobby")
		var from := nv.room_target(lobby, PlanGeo.interior_point(PlanGeo.room_poly(lobby)))
		for r in Store.rooms:
			var dest := nv.room_target(r, from)
			var path := nv.path(from, dest, false) if dest != Vector2.INF else PackedVector2Array()
			var seen: Array = []
			var length := 0.0
			for i in path.size():
				if i > 0:
					length += path[i].distance_to(path[i - 1])
				var rr: Dictionary = Store.room_at(path[i])
				if not rr.is_empty() and (seen.is_empty() or seen[seen.size() - 1] != rr.name):
					seen.append(rr.name)
			var ok: bool = r.key == "lift-lobby" or length > 0.5
			print("%s %s | %.1f m | %s" % ["WALK" if ok else "NO WAY IN", r.name, length, " > ".join(seen)])
		get_tree().quit()
		return
	var target: Dictionary = Store.room(room)
	Store.furniture = Store.furniture + WalkNav.auto_doors(Store.rooms, Store.furniture)
	var nav := WalkNav.new()
	nav.build(main.floor_builder.wall_pieces, main.floor_builder.lintels)
	var goal: Vector2 = PlanGeo.interior_point(PlanGeo.room_poly(target))
	if OS.get_cmdline_user_args().has("--routes-debug"):
		for f in Store.furniture:
			if f.get("kind", "") == "door" and Store.room_at(Vector2(float(f.x), float(f.z)) + Vector2(sin(float(f.rot)), cos(float(f.rot))) * 0.6).get("key", "") in [room, "lift-lobby"] or (f.get("kind", "") == "door" and Store.room_at(Vector2(float(f.x), float(f.z)) - Vector2(sin(float(f.rot)), cos(float(f.rot))) * 0.6).get("key", "") in [room, "lift-lobby"]):
				var c := Vector2(float(f.x), float(f.z))
				var nn := Vector2(sin(float(f.rot)), cos(float(f.rot)))
				var line := ""
				for t in [-1.0, -0.6, -0.3, 0.0, 0.3, 0.6, 1.0]:
					line += "%s " % ("." if nav.is_free(c + nn * t) else "#")
				var inn := nav.nearest_free(c + nn * 0.6, 4)
				var outp := nav.nearest_free(c - nn * 0.6, 4)
				var tgt := nav.room_target(Store.room_at(c + nn * 0.6), outp)
				print("  door->through: ", nav.path(outp, inn, false).size(), "  inside->target ", tgt, ": ", nav.path(inn, tgt, false).size(), "  centre->target: ", nav.path(nav.nearest_free(PlanGeo.interior_point(PlanGeo.room_poly(Store.room_at(c + nn * 0.6))), 30), tgt, false).size())
				print("DOOR ", f.x, ",", f.z, " w ", f.w, " rot ", f.rot, " across: ", line, " in-room: ", Store.room_at(c + nn * 0.6).get("key", "-"), " / ", Store.room_at(c - nn * 0.6).get("key", "-"))
	for r in Store.rooms:
		if not RegEx.create_from_string("(?i)stair|lift|lobby").search(str(r.name)):
			continue
		var start := nav.room_target(r, goal)
		var dest := nav.room_target(target, start)
		var path := nav.path(start, dest, false)
		var seen: Array = []
		var length := 0.0
		for i in path.size():
			if i > 0:
				length += path[i].distance_to(path[i - 1])
			var rr: Dictionary = Store.room_at(path[i])
			var nm := str(rr.get("name", "?")) if not rr.is_empty() else "(doorway)"
			if seen.is_empty() or seen[seen.size() - 1] != nm:
				if nm != "(doorway)":
					seen.append(nm)
		print("ROUTE %s | %.1f m | %s" % [r.name, length, " > ".join(seen)])
	get_tree().quit()
