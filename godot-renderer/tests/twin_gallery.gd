extends Node
## Opens one device of every type and saves a screenshot of its twin (exploded and assembled).
## Run against a running platform with the sample home:
##   godot --path . -- --gallery=/tmp/gallery [--assembled]

func _ready() -> void:
	var out := "/tmp"
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--gallery="):
			out = a.substr(10)
	# let the layout load and the plan-to-3D intro finish before taking pictures
	await get_tree().create_timer(6.0).timeout
	var main = get_parent()
	var seen := {}
	for d in Store.devices:
		if seen.has(d.type):
			continue
		seen[d.type] = true
		Bridge.handle({"type": "openDevice", "id": d.id})
		await get_tree().create_timer(0.75).timeout
		_shot("%s/%s_assembled.png" % [out, d.type])
		await get_tree().create_timer(2.4).timeout
		# frame the exploded twin from a fixed three-quarter view
		main.rig.jump(main.detail.centre(), DetailView.TWIN * 3.3, deg_to_rad(-22.0), d.get("rotationY", 0.0) + deg_to_rad(30.0))
		await get_tree().create_timer(0.6).timeout
		_shot("%s/%s.png" % [out, d.type])
		Bridge.handle({"type": "closeDevice"})
		await get_tree().create_timer(0.3).timeout
	print("GALLERY OK")
	get_tree().quit(0)


func _shot(path: String) -> void:
	get_viewport().get_texture().get_image().save_png(path)
