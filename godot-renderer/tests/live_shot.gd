extends Node
## --guest=<token> --live-shot=<dir>: turns on Find me, plays position fixes along the way from the lift to the room
## (as the "Demo" badge does) and saves what the map shows on the way and on arrival.

var out := "/tmp/live"


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--live-shot="):
			out = a.substr(12)
	_run.call_deferred()


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func _shot(n: String) -> void:
	await RenderingServer.frame_post_draw
	DirAccess.make_dir_recursive_absolute(out)
	get_viewport().get_texture().get_image().save_png("%s/%s.png" % [out, n])


func _run() -> void:
	var main := get_parent()
	for i in 240:
		if main.walker != null and main._guest_target != Vector2.INF:
			break
		await _wait(0.25)
	await _wait(2.0)
	var w = main.walker
	var path: PackedVector2Array = w.nav.path(w.p, main._guest_target)
	Bridge.handle({"type": "walk", "action": "live", "on": true})
	var n := 0
	var walked := 0.0
	var total := 0.0
	for i in path.size() - 1:
		total += path[i].distance_to(path[i + 1])
	var shots := {0.15: "1_start", 0.55: "2_on_the_way", 1.01: "3_arrived"}
	for i in path.size() - 1:
		var a: Vector2 = path[i]
		var b: Vector2 = path[i + 1]
		var steps := int(ceil(a.distance_to(b) / 1.2))
		for k in steps:
			var q := a.lerp(b, float(k + 1) / steps)
			walked += a.distance_to(b) / steps
			n += 1
			Store.me = {"x": q.x + randf_range(-0.6, 0.6), "z": q.y + randf_range(-0.6, 0.6), "accuracy": 1.5, "source": "rtls-sim", "at": float(n)}
			main._live_fix()
			await _wait(0.35)
			for f in shots.keys():
				if walked / total >= f and shots[f] != "":
					await _wait(1.6)
					await _shot(shots[f])
					print("shot ", shots[f], " at ", int(100 * walked / total), "%")
					shots[f] = ""
	await _wait(2.5)
	await _shot("3_arrived")
	print("LIVE SHOT done, ", n, " fixes")
	get_tree().quit()
