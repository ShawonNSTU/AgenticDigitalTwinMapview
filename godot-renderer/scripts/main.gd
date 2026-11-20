extends Node3D
## Builds the scene from data and wires Bus signals to the floor, devices, piping, detail view and camera.

# Fixed evening light (the look at 22:00): low sun, ambient light carries the room colours.
const SUN := 0.15
const SUN_TILT := -0.05
var rig: CameraRig
var floor_builder: FloorBuilder
var piping: Piping
var interior: Interior
var detail: DetailView
var sun: DirectionalLight3D
var hud: Label
var devices := {}  # id -> DeviceNode
var world: Node3D   # everything built from the layout; rebuilt when a plan is uploaded
var legend: Label
var placer: Placer
var _highlight: Array = []
var _pending_focus := ""  # a device the host asked to focus before it arrived from the platform


func _ready() -> void:
	get_viewport().physics_object_picking = true
	_environment()
	rig = CameraRig.new()
	add_child(rig)
	_hud()
	# Wait for the platform's layout so the bundled sample never flashes up first. Fall back to the
	# bundled sample only when the platform can't be reached (offline desktop run) or after 20 s.
	Bus.layout_changed.connect(func(): _build_world(true))
	Bus.devices_changed.connect(_rebuild_devices)
	Store.platform_unreachable.connect(func():
		if world == null:
			_build_world(true))
	get_tree().create_timer(20.0).timeout.connect(func():
		if world == null:
			_build_world(true))

	Bus.health_changed.connect(_on_health)
	Bus.highlight_requested.connect(_on_highlight)
	Bus.highlight_cleared.connect(func(): _on_highlight([], ""))
	Bus.focus_requested.connect(_on_focus)
	Bus.open_requested.connect(_on_open)
	Bus.close_requested.connect(_on_close)
	Bus.part_focus_requested.connect(func(id, part):
		if world == null:
			return
		if detail.device == null or detail.device.data.id != id:
			_on_open(id, part)
		else:
			detail.focus_part(part))
	Bus.trace_requested.connect(_on_trace)
	Bus.layer_changed.connect(_on_layer)
	Bus.reset_view_requested.connect(_on_reset)
	Bus.camera_requested.connect(func(action): rig.command(action))
	Bus.insets_changed.connect(func(l, r, t, b): rig.set_insets(l, r, t, b))
	Bus.time_changed.connect(_on_time)
	Bus.scenario_changed.connect(_on_scenario)
	_on_time(Store.t)
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--rooms="):
			var rs := Node.new()
			rs.set_script(load("res://tests/room_shots.gd"))
			add_child(rs)
		if a.begins_with("--place="):
			var pt := Node.new()
			pt.set_script(load("res://tests/place_test.gd"))
			add_child(pt)
		if a.begins_with("--gallery="):
			var g := Node.new()
			g.set_script(load("res://tests/twin_gallery.gd"))
			add_child(g)
		if a.begins_with("--camera="):
			var ct := Node.new()
			ct.set_script(load("res://tests/camera_test.gd"))
			add_child(ct)
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
	DeviceNode.dense = Store.devices.size() > 40
	interior = Interior.new()
	interior.name = "Interior"
	world.add_child(interior)
	interior.build(Store.furniture)
	_make_devices()
	detail = DetailView.new()
	world.add_child(detail)
	detail.part_selected.connect(func(pos, size): rig.fly_to(pos.lerp(detail.centre(), 0.3), clampf(size * 4.0, 1.2, 2.6)))
	detail.legend_changed.connect(func(text): legend.text = text)
	legend.text = ""
	placer = Placer.new()
	placer.name = "Placer"
	placer.rig = rig
	world.add_child(placer)
	var fr: Rect2 = Store.floor_rect()
	rig.set_bounds(fr)  # zoom range, pan limits and the home view follow the floor's size
	_on_time(Store.t)
	if animate:
		_play_plan_to_3d()
	Bridge.emit_event({"type": "floorBuilt", "rooms": Store.rooms.size(), "devices": Store.devices.size()})


func _make_devices() -> void:
	var holder := Node3D.new()
	holder.name = "Devices"
	world.add_child(holder)
	DeviceNode.dense = Store.devices.size() > 40
	for d in Store.devices:
		var n := DeviceNode.new()
		holder.add_child(n)
		devices[d.id] = n.setup(d)
	piping = Piping.new()
	piping.name = "Piping"
	world.add_child(piping)
	piping.build()


## Devices were placed, moved or removed on the same floor: rebuild devices and piping, keep the rest.
## New or moved devices drop in; the camera goes to the device the host asked for.
func _rebuild_devices() -> void:
	if world == null:
		return
	var before := {}
	for id in devices:
		before[id] = devices[id].position
	if detail.device and not Store.by_id.has(detail.device.data.id):
		_on_close()
	var open_id: String = detail.device.data.id if detail.device else ""
	if open_id != "":
		_on_close()
	var piping_on := piping.visible
	world.get_node("Devices").free()
	piping.free()
	devices.clear()
	_make_devices()
	piping.visible = piping_on
	for id in devices:
		var n: DeviceNode = devices[id]
		if before.has(id) and (before[id] as Vector3).distance_to(n.position) < 0.01:
			continue
		var y := n.position.y
		n.position.y = y + 1.8
		var tw := create_tween()
		tw.tween_property(n, "position:y", y, 0.5).set_trans(Tween.TRANS_BOUNCE).set_ease(Tween.EASE_OUT)
	if _highlight.size() > 0:
		_on_highlight(_highlight.filter(func(i): return devices.has(i)), "")
	if open_id != "" and devices.has(open_id):
		_on_open(open_id, "")
	elif _pending_focus != "" and devices.has(_pending_focus):
		_on_focus(_pending_focus)
	_pending_focus = ""


## Tour step "plan → 3D": top-down on the plan, walls rise, devices drop in, piping fades in, camera tilts.
func _play_plan_to_3d() -> void:
	rig.jump(rig.home_target, rig.home_distance, deg_to_rad(-88.0), 0.0)
	floor_builder.play_build_up()
	# interiors grow out of the floor once the walls are up
	interior.scale = Vector3(1, 0.01, 1)
	create_tween().tween_property(interior, "scale", Vector3.ONE, 0.7).set_delay(1.0).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	piping.visible = false
	var i := 0
	for id in devices:
		var n: DeviceNode = devices[id]
		var y := n.position.y
		n.position.y = y + 2.5
		n.visible = false
		var tw := create_tween()
		tw.tween_interval(1.4 + 0.02 * i)
		tw.tween_callback(func(): n.visible = detail.device == null or detail.device == n)
		tw.tween_property(n, "position:y", y, 0.45).set_trans(Tween.TRANS_BOUNCE).set_ease(Tween.EASE_OUT)
		i += 1
	get_tree().create_timer(1.6 + 0.02 * i).timeout.connect(func(): piping.visible = detail.device == null)
	get_tree().create_timer(1.0).timeout.connect(func(): rig.reset(1.8))


func _on_trace(id: String) -> void:
	if world:
		piping.trace(id)
		piping.visible = true


func _on_reset() -> void:
	if world:
		_on_close()
		piping.trace("")
	rig.reset()


func _on_scenario(_key: String) -> void:
	if world:
		_on_close()
		piping.trace("")
	_on_time(Store.t)  # refresh the HUD even before the scene exists


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
	sun.light_energy = SUN
	sun.rotation = Vector3(SUN_TILT, deg_to_rad(-35.0), 0)
	add_child(sun)


func _hud() -> void:
	var layer := CanvasLayer.new()
	add_child(layer)
	hud = Label.new()
	hud.position = Vector2(14, 10)
	hud.add_theme_color_override("font_color", Color(0.06, 0.09, 0.16, 0.85))
	layer.add_child(hud)
	legend = Label.new()
	legend.position = Vector2(14, 34)
	legend.add_theme_color_override("font_color", Color(0.06, 0.09, 0.16, 0.7))
	layer.add_child(legend)
	if OS.has_feature("web"):
		# the page shows the clock and its own panels on the left; keep only the flow legend, clear of the palette
		hud.visible = false
		legend.position = Vector2(270, 16)
	if not OS.has_feature("web"):
		var help := Label.new()
		help.text = "Click a device to focus · double-click to open · P piping · Esc back · drag orbit · right-drag pan · wheel zoom"
		help.add_theme_color_override("font_color", Color(0.06, 0.09, 0.16, 0.55))
		help.anchor_top = 1.0
		help.anchor_bottom = 1.0
		help.position = Vector2(14, -30)
		layer.add_child(help)


## The clock no longer moves the sun: the map keeps one fixed evening light (see SUN).
func _on_time(t: float) -> void:
	hud.text = "%02d:%02d   ·   scenario: %s" % [int(t), int((t - floorf(t)) * 60.0), Store.scenario]


func _on_health(id: String, h: String) -> void:
	if world == null:
		return
	if devices.has(id):
		devices[id].set_health(h)
	piping.refresh()


func _on_highlight(ids: Array, _reason: String) -> void:
	if world == null:
		return
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
	if world == null:
		return
	if devices.has(id):
		rig.fly_to(devices[id].global_position, 4.0)
	else:
		_pending_focus = id  # not here yet: it was just placed and is on its way from the platform


func _on_open(id: String, part: String) -> void:
	if world == null:
		return
	if not devices.has(id):
		return
	if placer.active():
		placer.cancel()
	Store.open_id = id
	var dev: DeviceNode = devices[id]
	# Only the opened device stays: other devices and the floor piping step back.
	for other in devices:
		devices[other].visible = other == id
	dev.set_highlight(false, false)
	piping.visible = false
	interior.visible = false  # furniture and columns step back so nothing hides the twin
	floor_builder.set_walls_faded(true)
	detail.open(dev)
	# Look at the front of the device (rotationY 0 faces +z), slightly from above.
	# Three-quarter view of the front (rotationY 0 faces +z), so depth inside the unit reads on screen.
	rig.fly_to(detail.centre(), DetailView.TWIN * 2.0, deg_to_rad(-24.0), dev.rotation.y + deg_to_rad(35.0))
	get_tree().create_timer(0.9).timeout.connect(func():
		if detail.device == dev:
			rig.fly_to(detail.centre(), DetailView.TWIN * 3.6, NAN, NAN, 0.7))
	if part != "":
		get_tree().create_timer(0.6).timeout.connect(func(): detail.focus_part(part))


func _on_close() -> void:
	if world == null:
		return
	if detail.device == null:
		return
	detail.close()
	for other in devices:
		devices[other].visible = true
	piping.visible = true
	interior.visible = true
	floor_builder.set_walls_faded(false)
	Store.open_id = ""
	Bus.device_closed.emit()
	rig.reset()


func _on_layer(layer: String, on: bool) -> void:
	if world == null:
		return
	match layer:
		"piping": piping.visible = on
		"devices":
			for id in devices:
				devices[id].visible = on
		"ids", "names":
			for id in devices:
				devices[id].show_label(on)
		"temperature": floor_builder.tint_rooms(on)
		"furniture": interior.visible = on
		"exploded": detail.set_exploded(on)


func _unhandled_input(e: InputEvent) -> void:
	if e.is_action_pressed("toggle_piping"):
		piping.visible = not piping.visible
	elif e.is_action_pressed("back"):
		if placer and placer.active():
			placer.cancel()
		elif detail.device:
			_on_close()
		else:
			Bus.highlight_cleared.emit()
			rig.reset()
