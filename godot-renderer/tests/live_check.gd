extends Node
## --live-check: feeds noisy positioning fixes (badge noise, and fixes pushed half a metre to the wrong side of a
## wall) along the guest route from the lift lobby to the SmartThings Experience Zone and checks the map matching:
## the matched spot must be reachable from the previous one without a detour round a wall (no wall crossing), and
## the walked route between them must be clear. Prints PASS/FAIL lines and "N failed".

func _ready() -> void:
	_run.call_deferred()


func _run() -> void:
	var main := get_parent()
	for i in 240:
		if main.world != null and not Store.room("smartthings-experience-zone").is_empty():
			break
		await get_tree().create_timer(0.25).timeout
	await get_tree().create_timer(2.0).timeout
	Store.furniture = Store.furniture + WalkNav.auto_doors(Store.rooms, Store.furniture)
	var nav := WalkNav.new()
	nav.build(main.floor_builder.wall_pieces, main.floor_builder.lintels)
	var failed := 0
	var keys := {}
	for r in Store.rooms:
		keys[str(r.name)] = str(r.key)
	var by := func(rx: String) -> String:
		for r in Store.rooms:
			if RegEx.create_from_string("(?i)" + rx).search(str(r.name)):
				return str(r.key)
		return ""
	var pairs := [["lift-lobby", "smartthings-experience-zone"], [by.call("gym"), "smartthings-experience-zone"], [by.call("cafeteria \\(208"), by.call("medical")], [by.call("hub"), by.call("training room 403")]]
	for pair in pairs:
		var from_r: Dictionary = Store.room(pair[0])
		var to_r: Dictionary = Store.room(pair[1])
		if from_r.is_empty() or to_r.is_empty():
			print("FAIL  no room %s or %s" % pair)
			failed += 1
			continue
		# stand where a person would in each room (its open floor nearest the way in from the lift lobby)
		var lob := nav.room_target(Store.room("lift-lobby"), Vector2.ZERO)
		var start := nav.room_target(from_r, lob)
		var goal := nav.room_target(to_r, start)
		var route := nav.path(start, goal, false)
		if route.size() < 2:
			print("FAIL  no walking route %s > %s" % [from_r.name, to_r.name])
			failed += 1
			continue
		var truth: Array = []
		for i in range(1, route.size()):
			var a := route[i - 1]
			var b := route[i]
			var n := maxi(1, int(ceil(a.distance_to(b) / 1.2)))
			for k in n:
				truth.append(a.lerp(b, float(k + 1) / n))
		for seed in [7, 11, 23]:
			var rng := RandomNumberGenerator.new()
			rng.seed = seed
			for mode in ["noise", "wrong side"]:
				var p := start
				var old_p := start
				var bad := 0
				var old_bad := 0
				var off := 0.0
				for t in truth:
					var raw: Vector2 = t + Vector2(rng.randf_range(-0.35, 0.35), rng.randf_range(-0.35, 0.35))
					if mode == "wrong side":
						# the fix pushed 0.75 m towards the nearest wall beside the true spot
						var best := Vector2.ZERO
						for k in 16:
							var d := Vector2(cos(TAU * k / 16.0), sin(TAU * k / 16.0))
							if not nav.is_free(t + d * 0.6) and best == Vector2.ZERO:
								best = d
						raw = t + best * 0.75
					var q := nav.match_fix(raw, p, 0.6, true)
					# across a wall: reaching the matched spot takes a detour that reaching the true spot does not
					if nav.path_length(p, q) > nav.path_length(p, t) + 1.5:
						bad += 1
					off = maxf(off, q.distance_to(t))
					p = q
					var oq := nav.nearest_free(raw, 30)
					if nav.path_length(old_p, oq) > nav.path_length(old_p, t) + 1.5:
						old_bad += 1
					old_p = oq
				var ok := bad == 0 and off < 1.6
				if not ok:
					failed += 1
				print("%s  %s > %s, seed %d, %s: %d fixes, matched across a wall: %d (plain nearest-floor snapping: %d), furthest from the true spot %.2f m" % ["PASS" if ok else "FAIL", from_r.name, to_r.name, seed, mode, truth.size(), bad, old_bad, off])
	print("%d failed" % failed)
	get_tree().quit()
