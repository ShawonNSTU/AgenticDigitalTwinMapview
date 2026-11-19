extends Node
## Close-ups of named rooms (interiors check). Run against a running platform:
##   godot --path . -- --rooms=/tmp/rooms "--room=Gym Room" "--room=Cafeteria (208 seats)"

func _ready() -> void:
	var out := "/tmp"
	var names: Array = []
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--rooms="): out = a.substr(8)
		elif a.begins_with("--room="): names.append(a.substr(7))
	await Bus.layout_changed
	await get_tree().create_timer(4.0).timeout  # plan-to-3D intro
	var main = get_parent()
	print("interior items: ", main.interior.counts, " draw batches: ", main.interior.draw_calls())
	main.rig.jump(main.rig.home_target, main.rig.home_distance * 0.75, deg_to_rad(-48.0), deg_to_rad(-25.0))
	await get_tree().create_timer(0.5).timeout
	_shot(out + "/0_overview.png")
	var i := 1
	for n in names:
		for r in Store.rooms:
			if r.name == n:
				var poly := PlanGeo.room_poly(r)
				var c := PlanGeo.interior_point(poly)
				var box := Rect2(poly[0], Vector2.ZERO)
				for v in poly:
					box = box.expand(v)
				main.rig.jump(Vector3(c.x, 0.4, c.y), clampf(box.size.length() * 0.7, 5.0, 26.0), deg_to_rad(-42.0), deg_to_rad(-30.0))
				await get_tree().create_timer(0.6).timeout
				_shot("%s/%d_%s.png" % [out, i, n.to_snake_case().replace("/", "")])
				i += 1
	print("ROOM SHOTS OK")
	get_tree().quit(0)


func _shot(path: String) -> void:
	get_viewport().get_texture().get_image().save_png(path)
