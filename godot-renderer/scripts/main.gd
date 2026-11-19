extends Node3D
## Builds the scene from data and wires Bus signals to the floor, devices, piping, detail view and camera.

var rig: CameraRig
var floor_builder: FloorBuilder
var piping: Piping
var detail: DetailView
var sun: DirectionalLight3D
var hud: Label
var devices := {}  # id -> DeviceNode
var world: Node3D   # everything built from the layout; rebuilt when a plan is uploaded
var legend: Label
var _highlight: Array = []


func _ready() -> void:
	get_viewport().physics_object_picking = true
	_environment()
	rig = CameraRig.new()
	add_child(rig)
	_hud()
	_build_world(false)
	Bus.layout_changed.connect(func(): _build_world(true))

	Bus.health_changed.connect(_on_health)
	Bus.highlight_requested.connect(_on_highlight)
	Bus.highlight_cleared.connect(func(): _on_highlight([], ""))
	Bus.focus_requested.connect(_on_focus)
	Bus.open_requested.connect(_on_open)
	Bus.close_requested.connect(_on_close)
	Bus.part_focus_requested.connect(func(id, part):
		if detail.device == null or detail.device.data.id != id:
			_on_open(id, part)
		else:
			detail.focus_part(part))
	Bus.trace_requested.connect(func(id): piping.trace(id); piping.visible = true)
	Bus.layer_changed.connect(_on_layer)
	Bus.reset_view_requested.connect(func(): _on_close(); piping.trace(""); rig.reset())
	Bus.time_changed.connect(_on_time)
	Bus.scenario_changed.connect(func(_k): _on_close(); piping.trace(""); _on_time(Store.t))
	_on_time(Store.t)
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--demo-shots="):
			var shots := Node.new()
			shots.set_script(load("res://tests/demo_shots.gd"))
			add_child(shots)
	if OS.get_cmdline_user_args().has("--smoke"):
		var smoke := Node.new()
		smoke.set_script(load("res://tests/smoke.gd"))
		add_child(smoke)


func _build_world(animate: bool) -> void:
	if world:
		Store.open_id = ""
		world.free()
	devices.clear()
	_highlight = []
	world = Node3D.new()
	world.name = "World"
	add_child(world)
	floor_builder = FloorBuilder.new()
	world.add_child(floor_builder)
	floor_builder.build()
	var holder := Node3D.new()
	holder.name = "Devices"
	world.add_child(holder)
	for d in Store.devices:
		var n := DeviceNode.new()
		holder.add_child(n)
		devices[d.id] = n.setup(d)
	piping = Piping.new()
	world.add_child(piping)
	piping.build()
	detail = DetailView.new()
	world.add_child(detail)
	detail.part_selected.connect(func(pos): rig.fly_to(pos.lerp(detail.device.global_position, 0.35) if detail.device else pos, 1.9))
	detail.legend_changed.connect(func(text): legend.text = text)
	legend.text = ""
	var fr: Rect2 = Store.floor_rect()
	rig.set_home(Vector3(fr.get_center().x, 0, fr.get_center().y), clampf(fr.size.length() * 0.95, 8.0, 60.0))
	if animate:
		_play_plan_to_3d()


## Tour step "plan → 3D": top-down on the plan, walls rise, devices drop in, piping fades in, camera tilts.
func _play_plan_to_3d() -> void:
	rig.jump(rig.home_target, rig.home_distance, deg_to_rad(-88.0), 0.0)
	floor_builder.play_build_up()
	piping.visible = false
	var i := 0
	for id in devices:
		var n: DeviceNode = devices[id]
		var y := n.position.y
		n.position.y = y + 2.5
		n.visible = false
		var tw := create_tween()
		tw.tween_interval(1.4 + 0.02 * i)
		tw.tween_callback(func(): n.visible = true)
		tw.tween_property(n, "position:y", y, 0.45).set_trans(Tween.TRANS_BOUNCE).set_ease(Tween.EASE_OUT)
		i += 1
	get_tree().create_timer(1.6 + 0.02 * i).timeout.connect(func(): piping.visible = true)
	get_tree().create_timer(1.0).timeout.connect(func(): rig.reset(1.8))


func _environment() -> void:
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color("0b0e12")
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color("aab4c3")
	env.ambient_light_energy = 0.55
	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	env.glow_enabled = true
	env.glow_intensity = 0.6
	env.ssao_enabled = true  # Forward+ only; ignored by the web (Compatibility) renderer
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)
	sun = DirectionalLight3D.new()
	sun.shadow_enabled = true
	sun.light_energy = 1.1
	add_child(sun)


func _hud() -> void:
	var layer := CanvasLayer.new()
	add_child(layer)
	hud = Label.new()
	hud.position = Vector2(14, 10)
	hud.add_theme_color_override("font_color", Color(1, 1, 1, 0.85))
	layer.add_child(hud)
	legend = Label.new()
	legend.position = Vector2(14, 34)
	legend.add_theme_color_override("font_color", Color(1, 1, 1, 0.65))
	layer.add_child(legend)
	if not OS.has_feature("web"):
		var help := Label.new()
		help.text = "Click a device to focus · double-click to open · P piping · Esc back · drag orbit · right-drag pan · wheel zoom"
		help.add_theme_color_override("font_color", Color(1, 1, 1, 0.5))
		help.anchor_top = 1.0
		help.anchor_bottom = 1.0
		help.position = Vector2(14, -30)
		layer.add_child(help)


## 4D: the sun follows the simulated clock (06:00 east, 14:00 high, 22:00 below the horizon).
func _on_time(t: float) -> void:
	var day := clampf((t - 6.0) / 14.0, 0.0, 1.0)
	sun.rotation = Vector3(-lerpf(0.15, PI - 0.15, day) if t < 20.0 else -0.05, deg_to_rad(-35.0), 0)
	sun.light_energy = 1.1 if t < 19.0 else lerpf(1.1, 0.15, clampf((t - 19.0) / 2.0, 0.0, 1.0))
	hud.text = "%02d:%02d   ·   scenario: %s" % [int(t), int((t - floorf(t)) * 60.0), Store.scenario]


func _on_health(id: String, h: String) -> void:
	if devices.has(id):
		devices[id].set_health(h)
	piping.refresh()


func _on_highlight(ids: Array, _reason: String) -> void:
	_highlight = ids
	for id in devices:
		devices[id].set_highlight(ids.has(id), not ids.is_empty())
	if ids.size() == 1:
		_on_focus(ids[0])
	elif ids.size() > 1:
		var box := AABB(devices[ids[0]].global_position, Vector3.ZERO) if devices.has(ids[0]) else AABB()
		for id in ids:
			if devices.has(id):
				box = box.expand(devices[id].global_position)
		rig.fly_to(box.get_center(), clampf(box.size.length() * 1.3 + 4.0, 6.0, 22.0))


func _on_focus(id: String) -> void:
	if devices.has(id):
		rig.fly_to(devices[id].global_position, 4.0)


func _on_open(id: String, part: String) -> void:
	if not devices.has(id):
		return
	Store.open_id = id
	var dev: DeviceNode = devices[id]
	# Only the opened device stays: other devices and the floor piping step back.
	for other in devices:
		devices[other].visible = other == id
	dev.set_highlight(false, false)
	piping.visible = false
	detail.open(dev, rig.yaw)
	var dist: float = Store.types.get(dev.data.type, {}).get("cameraDistance", 2.5)
	rig.fly_to(dev.global_position + Vector3(0, 0.15, 0), dist + 0.4, deg_to_rad(-18.0))
	if part != "":
		get_tree().create_timer(0.6).timeout.connect(func(): detail.focus_part(part))


func _on_close() -> void:
	if detail.device == null:
		return
	detail.close()
	for other in devices:
		devices[other].visible = true
	piping.visible = true
	Store.open_id = ""
	Bus.device_closed.emit()
	rig.reset()


func _on_layer(layer: String, on: bool) -> void:
	match layer:
		"piping": piping.visible = on
		"devices":
			for id in devices:
				devices[id].visible = on
		"ids", "names":
			for id in devices:
				devices[id].show_label(on)
		"temperature": floor_builder.tint_rooms(on)


func _unhandled_input(e: InputEvent) -> void:
	if e.is_action_pressed("toggle_piping"):
		piping.visible = not piping.visible
	elif e.is_action_pressed("back"):
		if detail.device:
			_on_close()
		else:
			Bus.highlight_cleared.emit()
			rig.reset()
