extends Node
## --eye-shots=<dir>: walks into the floor and takes eye-level pictures looking at a few structural columns (and
## whatever furniture is around them), to judge how the floor reads when walking.

var out := "/tmp/eye"


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--eye-shots="):
			out = a.substr(12)
	_run.call_deferred()


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func _run() -> void:
	var main := get_parent()
	for i in 200:
		if not Store.furniture.is_empty() and main.floor_builder != null:
			break
		await _wait(0.25)
	await _wait(1.0)
	var cols := Store.furniture.filter(func(f): return f.kind == "column")
	print("columns: ", cols.size())
	main.start_walk("")
	for i in 80:
		if main.walker != null:
			break
		await _wait(0.25)
	await _wait(3.0)
	var w = main.walker
	DirAccess.make_dir_recursive_absolute(out)
	var n := 0
	for f in cols:
		if n >= 5:
			break
		var c := Vector2(float(f.x), float(f.z))
		# a free spot 3-4.5 m away, with the column in front
		var spot := Vector2.INF
		for k in 16:
			var a := TAU * k / 16.0
			for r in [3.5, 4.5, 3.0]:
				var q: Vector2 = c + Vector2(cos(a), sin(a)) * r
				if w.nav.is_free(q):
					spot = q
					break
			if spot != Vector2.INF:
				break
		if spot == Vector2.INF:
			continue
		w.teleport(spot)
		await _wait(1.6)
		w.look_at_point(Vector3(c.x, 1.3, c.y))
		await _wait(1.4)
		await RenderingServer.frame_post_draw
		n += 1
		get_viewport().get_texture().get_image().save_png("%s/column_%d.png" % [out, n])
		print("shot ", n, " ", Store.room_label(Store.room_at(c)))
	get_tree().quit()
