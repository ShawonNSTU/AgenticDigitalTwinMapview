extends Node
## --fx-shots=<dir> [--fx-room=<key>]: screenshots of a room's devices reacting to their state (platform running).

var out := "/tmp/fx"
var room := "training-room-403-sajek"


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--fx-shots="):
			out = a.substr(11)
		if a.begins_with("--fx-room="):
			room = a.substr(10)
	DirAccess.make_dir_recursive_absolute(out)
	_run.call_deferred()


func _shot(name: String) -> void:
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png(out + "/" + name + ".png")
	print("shot ", name)


func _run() -> void:
	var main := get_parent()
	for i in 200:
		if main.world != null and Store.layout_version > 0 and Store.live.size() > 0:
			break
		await get_tree().create_timer(0.25).timeout
	await get_tree().create_timer(4.0).timeout
	var r: Dictionary = Store.room(room)
	var c := PlanGeo.interior_point(PlanGeo.room_poly(r))
	main.rig.fly_to(Vector3(c.x, 0, c.y), 9.0, deg_to_rad(-48.0), deg_to_rad(-30.0), 0.1)
	await get_tree().create_timer(3.0).timeout
	await _shot("m_room")
	Bridge.handle({"type": "walk", "action": "start", "room": room})
	await get_tree().create_timer(4.0).timeout
	await _shot("w_entry")  # the view on entering the room
	for k in 4:
		main.walker.yaw += PI / 2
		main.walker._apply()
		await get_tree().create_timer(1.5).timeout
		await _shot("w_%d" % k)
	get_tree().quit()
