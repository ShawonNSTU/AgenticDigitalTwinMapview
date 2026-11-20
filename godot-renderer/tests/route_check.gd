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
		if main.world != null and not Store.room(room).is_empty():
			break
		await get_tree().create_timer(0.25).timeout
	await get_tree().create_timer(2.0).timeout
	var target: Dictionary = Store.room(room)
	Store.furniture = Store.furniture + WalkNav.auto_doors(Store.rooms, Store.furniture)
	var nav := WalkNav.new()
	nav.build(main.floor_builder.wall_pieces, main.floor_builder.lintels)
	var goal: Vector2 = PlanGeo.interior_point(PlanGeo.room_poly(target))
	for r in Store.rooms:
		if not RegEx.create_from_string("(?i)stair|lift|lobby").search(str(r.name)):
			continue
		var start := nav.room_target(r, goal)
		var path := nav.path(start, goal, false)
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
