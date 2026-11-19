extends Node
## Screenshots of the upload flow against a running platform.
## Run: godot --path . --rendering-driver opengl3 -- --demo-shots=/tmp/out --open=AC-01 --part=filter
## Expects a floor plan already uploaded (POST /api/building), so the layout arrives and plays plan → 3D.

func _ready() -> void:
	var out := "/tmp"
	var open_id := ""
	var part := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--demo-shots="): out = a.substr(13)
		elif a.begins_with("--open="): open_id = a.substr(7)
		elif a.begins_with("--part="): part = a.substr(7)
	await Bus.layout_changed
	await get_tree().create_timer(0.9).timeout
	_shot(out + "/1_plan.png")
	await get_tree().create_timer(3.2).timeout
	_shot(out + "/2_map.png")
	var bad: Array = []
	for id in Store.health:
		if Store.health[id] != "ok":
			bad.append(id)
	Bridge.handle({"type": "highlight", "ids": bad})
	await get_tree().create_timer(1.5).timeout
	_shot(out + "/3_highlight.png")
	if open_id != "":
		Bridge.handle({"type": "openDevice", "id": open_id})
		await get_tree().create_timer(3.0).timeout
		_shot(out + "/4_open.png")
		if part != "":
			Bridge.handle({"type": "focusPart", "id": open_id, "part": part})
			await get_tree().create_timer(2.0).timeout
			_shot(out + "/5_part.png")
	print("DEMO SHOTS OK")
	get_tree().quit(0)


func _shot(path: String) -> void:
	get_viewport().get_texture().get_image().save_png(path)
	print("saved ", path)
