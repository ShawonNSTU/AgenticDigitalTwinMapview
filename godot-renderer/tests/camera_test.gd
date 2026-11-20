extends Node
## --camera=<dir>: checks the camera on floors of very different sizes, without the platform.
## For each size: the whole floor is inside the view after fit, zooming out reaches at least twice the fit
## distance and stops at a limit, zoom in/out/rotate/top commands work, and panning stays near the floor.
## Writes result.txt (PASS/FAIL lines) and a screenshot per size.

var out := "/tmp/camera"
var lines: Array = []
var failed := 0


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--camera="):
			out = a.substr(9)
	DirAccess.make_dir_recursive_absolute(out)
	_run.call_deferred()


func _check(ok: bool, what: String) -> void:
	lines.append(("PASS  " if ok else "FAIL  ") + what)
	if not ok:
		failed += 1


func _wait(s: float) -> void:
	await get_tree().create_timer(s).timeout


## True if every corner of the floor projects inside the viewport.
func _in_view(rig: CameraRig, r: Rect2) -> bool:
	var vp := get_viewport().get_visible_rect().size
	for c in [r.position, Vector2(r.end.x, r.position.y), r.end, Vector2(r.position.x, r.end.y)]:
		var p := Vector3(c.x, 0, c.y)
		if rig.cam.is_position_behind(p):
			return false
		var s := rig.cam.unproject_position(p)
		if s.x < 0 or s.y < 0 or s.x > vp.x or s.y > vp.y:
			return false
	return true


func _run() -> void:
	var rig := CameraRig.new()
	add_child(rig)
	rig.cam.current = true
	# a marker floor so the screenshots show what the camera sees
	var floor := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	floor.mesh = pm
	add_child(floor)
	var sun := DirectionalLight3D.new()
	sun.rotation = Vector3(-1.0, 0.6, 0)
	add_child(sun)
	for size in [Vector2(8, 6), Vector2(19, 14), Vector2(54, 39), Vector2(120, 80), Vector2(300, 60)]:
		var r := Rect2(-size / 2.0 + Vector2(3, -2), size)
		pm.size = size
		floor.position = Vector3(r.get_center().x, 0, r.get_center().y)
		rig.set_bounds(r)
		await _wait(0.1)
		var tag := "%dx%d m" % [size.x, size.y]
		_check(_in_view(rig, r), "%s: whole floor in view at the home view (distance %.1f)" % [tag, rig.distance])
		await _shot("fit_%dx%d" % [size.x, size.y])
		# zoom out as far as it goes
		for i in 40:
			rig.zoom_step(-1.0)
		await _wait(1.2)
		_check(rig.distance >= rig.home_distance * 2.0 - 0.01, "%s: zoom out reaches %.1f (fit %.1f)" % [tag, rig.distance, rig.home_distance])
		_check(rig.distance <= rig.max_distance + 0.01, "%s: zoom out stops at the limit %.1f" % [tag, rig.max_distance])
		_check(_in_view(rig, r), "%s: whole floor still in view zoomed out" % tag)
		# zoom in
		for i in 60:
			rig.zoom_step(1.0)
		await _wait(1.2)
		_check(rig.distance <= CameraRig.MIN_DISTANCE + 0.05, "%s: zoom in reaches the minimum (%.2f)" % [tag, rig.distance])
		# top view, rotate, fit
		rig.command("top")
		await _wait(1.0)
		_check(rig.is_top and _in_view(rig, r), "%s: top view shows the whole floor" % tag)
		rig.command("perspective")
		await _wait(1.0)
		var y0 := rig.yaw
		rig.command("rotateRight")
		await _wait(0.8)
		_check(absf(wrapf(rig.yaw - y0, -PI, PI) - deg_to_rad(45.0)) < 0.02, "%s: rotate 45°" % tag)
		rig.command("fit")
		await _wait(1.0)
		_check(_in_view(rig, r), "%s: fit shows the whole floor after rotating" % tag)
		# pan far away: target stays near the floor
		for i in 200:
			rig._pan(Vector2(400, 0))
		var b := r.grow(maxf(r.size.length() * 0.25, 4.0) + 0.01)
		_check(b.has_point(Vector2(rig.target.x, rig.target.z)), "%s: panning stays near the floor" % tag)
		rig.reset(0.01)
		await _wait(0.3)
	lines.append("%d failed" % failed)
	var f := FileAccess.open(out + "/result.txt", FileAccess.WRITE)
	f.store_string("\n".join(lines) + "\n")
	f.close()
	print("\n".join(lines))
	get_tree().quit(1 if failed else 0)


func _shot(n: String) -> void:
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png("%s/%s.png" % [out, n])
