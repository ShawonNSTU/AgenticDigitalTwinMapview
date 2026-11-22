extends Node
## --guest=<token> --tour-trace[=<dir>]: lets the guest arrive in their room, then takes the device tour the way the
## guest page does (one "show" per device, waiting for "viewing"), and reports per stop how far the walker went,
## whether it doubled back, how much it turned, how long it took and whether the device ended up on screen.
## With a dir, saves a picture at each stop. Fails on a stop that never arrives, ends with the device off screen,
## or walks back and forth.

var out := ""
var _viewing := ""


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--tour-trace="):
			out = a.substr(13)
	Bus.walk_changed.connect(func(s: Dictionary): if s.has("viewing"): _viewing = str(s.viewing))
	_run.call_deferred()


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


func _run() -> void:
	var main := get_parent()
	for i in 400:
		if main.walker != null and main._guest_settled:
			break
		await _wait(0.25)
	if not main._guest_settled:
		print("TOUR FAIL never arrived in the room")
		get_tree().quit(1)
		return
	await _wait(2.5)
	var w = main.walker
	var bad := 0
	var room_ids: Array = []
	for d in Store.devices:
		if str(d.get("room", "")) == main._guest_room:
			room_ids.append(str(d.id))
	print("tour of %d devices in %s" % [room_ids.size(), main._guest_room])
	for i in room_ids.size():
		var id: String = room_ids[i]
		_viewing = ""
		var start: Vector2 = w.p
		var last: Vector2 = w.p
		var dist := 0.0
		var turn := 0.0
		var last_yaw: float = w.yaw
		var back := 0
		var prev_dir := Vector2.ZERO
		var t0 := Time.get_ticks_msec()
		Bridge.handle({"type": "walk", "action": "show", "id": id})
		while _viewing != id and Time.get_ticks_msec() - t0 < 15000:
			await get_tree().process_frame
			var step: Vector2 = w.p - last
			if step.length() > 0.002:
				var dir := step.normalized()
				if prev_dir != Vector2.ZERO and dir.dot(prev_dir) < -0.5:
					back += 1
				prev_dir = dir
				dist += step.length()
			turn += absf(angle_difference(last_yaw, w.yaw))
			last_yaw = w.yaw
			last = w.p
		await _wait(1.2)   # the turn to the device
		var dev: Node3D = main.devices[id]
		var cam: Camera3D = get_viewport().get_camera_3d()
		var on_screen := not cam.is_position_behind(dev.global_position) and get_viewport().get_visible_rect().has_point(cam.unproject_position(dev.global_position))
		var ok := _viewing == id and on_screen and back <= 1
		if not ok:
			bad += 1
		print("%s %-10s %4.1f m walked, %3d° turned, %d reversals, %5.1f s, %s" % ["ok  " if ok else "BAD ", id, dist, int(rad_to_deg(turn)), back, (Time.get_ticks_msec() - t0) / 1000.0,
			("in view" if on_screen else "NOT IN VIEW") if _viewing == id else "never arrived"])
		if out != "":
			DirAccess.make_dir_recursive_absolute(out)
			await RenderingServer.frame_post_draw
			get_viewport().get_texture().get_image().save_png("%s/stop_%02d_%s.png" % [out, i + 1, id])
	print("TOUR %s  %d of %d stops wrong" % ["FAIL" if bad else "OK", bad, room_ids.size()])
	get_tree().quit(1 if bad else 0)
