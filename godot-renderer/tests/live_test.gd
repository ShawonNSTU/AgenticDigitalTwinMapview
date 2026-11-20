extends Node
## --guest=<token> --live-check=<dir>: the guest's view follows live position fixes (platform running).
## Feeds noisy badge fixes along the way to the room (some landing inside walls or in closed rooms) and checks
## the view never passes through a wall, stays in the open rooms, re-plans the way and arrives.

var out := "/tmp/live"
var lines: Array = []
var failed := 0


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--live-check="):
			out = a.substr(13)
	DirAccess.make_dir_recursive_absolute(out)
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	lines.append(("PASS  " if ok else "FAIL  ") + what)
	print(lines[-1])
	if not ok:
		failed += 1


func _run() -> void:
	var main := get_parent()
	for i in 240:
		if main.walker != null:
			break
		await get_tree().create_timer(0.25).timeout
	var w: Walker = main.walker
	if w == null:
		_check(false, "guest walk started")
		_finish()
		return
	Bridge.handle({"type": "walk", "action": "live", "on": true})
	_check(w.live and w._path.is_empty(), "live mode: the planned walk stops, the view waits for fixes")
	var start := w.p
	var route := w.nav.path(start, main._guest_target)
	var pts := PackedVector2Array([start]) + route
	var pieces: Array = main.floor_builder.wall_pieces
	var crossed := 0
	var outside := 0
	var rng := RandomNumberGenerator.new()
	rng.seed = 7
	var got := {"arrived": false}
	w.arrived.connect(func(): got.arrived = true)
	var n := 0
	for i in pts.size() - 1:
		var a := pts[i]
		var b := pts[i + 1]
		var steps := maxi(1, int(a.distance_to(b) / 1.2))
		for k in steps:
			var q := a.lerp(b, float(k + 1) / steps)
			var noise := Vector2(rng.randf_range(-0.6, 0.6), rng.randf_range(-0.6, 0.6))
			if n % 7 == 3:
				noise *= 3.0  # an outlier: often inside a wall or a closed room
			n += 1
			Store.me = {"x": q.x + noise.x, "z": q.y + noise.y, "accuracy": 0.6, "source": "rtls", "at": float(n)}
			main._live_fix()
			for s in 20:  # one second of walking per fix
				var before := w.p
				w._process(0.05)
				for sg in pieces:
					if Geometry2D.segment_intersects_segment(before, w.p, sg[0], sg[1]) != null:
						crossed += 1
				var r: Dictionary = Store.room_at(w.p)
				if not r.is_empty() and not Store.guest_allowed.has(r.key):
					outside += 1
	for s in 60:
		w._process(0.05)
	w._track_room()
	main._live_fix()
	_check(n > 5, "%d noisy fixes fed along %.0f m" % [n, start.distance_to(main._guest_target)])
	_check(crossed == 0, "the view never passed through a wall (%d)" % crossed)
	_check(outside == 0, "the view stayed in the open rooms (%d steps elsewhere)" % outside)
	_check(w.room_key == Store.guest.get("room", ""), "arrived in the room by following the fixes (in %s)" % w.room_key)
	_check(not w._confine.is_empty(), "on arrival the guest is kept in the room")
	_check(w._you != null and w._you.visible and w._you_label.text.begins_with("You are here"), "\"You are here\" marker with accuracy shown")
	_finish()


func _finish() -> void:
	lines.append("%d failed" % failed)
	var f := FileAccess.open(out + "/result.txt", FileAccess.WRITE)
	f.store_string("\n".join(lines) + "\n")
	f.close()
	get_tree().quit()
