extends Node
## Drives every bridge command once and optionally saves a screenshot.
## Run: godot --path . -- --smoke [--shot=res://shot.png]
## Exits with code 1 if a command errors (script errors are printed by the engine).

var steps := [
	{"type": "highlight", "ids": ["AC-04", "AC-05"], "reason": "test"},
	{"type": "setLayer", "layer": "temperature", "on": true},
	{"type": "trace", "from": "AC-04"},
	{"type": "focusDevice", "id": "AC-05"},
	{"type": "openDevice", "id": "AC-05", "part": "filter"},
	{"type": "focusPart", "id": "AC-05", "part": "coil"},
	{"type": "setTime", "t": 15.5},
	{"type": "closeDevice"},
	{"type": "clearHighlight"},
	{"type": "setScenario", "key": "refrig"},
	{"type": "resetView"},
	{"type": "openDevice", "id": "AC-05"},
]


func _ready() -> void:
	var shot := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--shot="):
			shot = a.substr(7)
	var run: Array = steps
	if OS.get_cmdline_user_args().has("--live"):
		# Leave live health from the platform alone and end on the traced refrigerant circuit.
		run = [{"type": "setLayer", "layer": "temperature", "on": true}, {"type": "trace", "from": "AC-04"}, {"type": "highlight", "ids": ["AC-03", "AC-04", "ODU-01"]}]
		await get_tree().create_timer(2.5).timeout
	while get_parent().world == null:  # the scene is built once a layout is known (or after the 2.5 s fallback)
		await get_tree().process_frame
	for s in run:
		Bridge.handle(s)
		await get_tree().create_timer(0.3).timeout
	# Fake live data so part labels and colours update without the platform.
	if not OS.get_cmdline_user_args().has("--live"):
		Bus.device_data.emit("AC-05", {"id": "AC-05", "parts": [{"key": "filter", "value": "Clogged 85 %", "health": "fault"}, {"key": "coil", "value": "1.8 °C", "health": "watch"}]})
	await get_tree().create_timer(1.2).timeout
	if shot != "":
		var img := get_viewport().get_texture().get_image()
		img.save_png(shot)
		print("saved ", shot)
	print("SMOKE OK")
	get_tree().quit(0)
