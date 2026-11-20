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
var env: Environment
var walker: Walker        # first-person walk-through, or null on the map
var _walk_saved := {}     # map wall height and plan furniture, restored when the walk ends
var _walk_build := false  # the world is being rebuilt to enter or leave the walk
const WALK_HEIGHT := 2.7  # metres, floor to ceiling while walking
const WALK_AMBIENT := 0.5  # low enough that the room's own lights (and switching them) show


func _ready() -> void:
	get_viewport().physics_object_picking = true
	_environment()
	rig = CameraRig.new()
	add_child(rig)
	_hud()
	# Wait for the platform's layout so the bundled sample never flashes up first. Fall back to the
	# bundled sample only when the platform can't be reached (offline desktop run) or after 20 s.
	Bus.layout_changed.connect(func(): _build_world(Store.guest_token == ""))  # guests go straight to their walk
	Bus.devices_changed.connect(_rebuild_devices)
	Store.platform_unreachable.connect(func():
		if world == null and Store.guest_token == "":
			_build_world(true))
	get_tree().create_timer(20.0).timeout.connect(func():
		if world == null and Store.guest_token == "":
			_build_world(true))

	Bus.health_changed.connect(_on_health)
	Bus.live_updated.connect(_apply_live)
	Bus.highlight_requested.connect(_on_highlight)
	Bus.highlight_cleared.connect(func(): _on_highlight([], ""))
	Bus.focus_requested.connect(func(id):
		if piping and is_instance_valid(piping):
			piping.focus(id)  # the selected AC or outdoor unit shows its circuits ("" = none selected)
		if id != "":
			_on_focus(id))
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
	Bus.camera_requested.connect(func(action):
		if walker == null:
			rig.command(action))
	Bus.walk_requested.connect(_on_walk)
	Bus.walk_changed.connect(func(_i): _room_light())
	Bus.device_clicked.connect(func(_id): _device_click_ms = Time.get_ticks_msec())
	Bus.room_selected.connect(func(key):
		if world:
			floor_builder.select_room(key))
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
		if a.begins_with("--fx-shots="):
			var fs := Node.new()
			fs.set_script(load("res://tests/fx_shots.gd"))
			add_child(fs)
		if a.begins_with("--guest-check="):
			var gt := Node.new()
			gt.set_script(load("res://tests/guest_test.gd"))
			add_child(gt)
		if a.begins_with("--walk="):
			var wt := Node.new()
			wt.set_script(load("res://tests/walk_test.gd"))
			add_child(wt)
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
	if walker and not _walk_build:
		_end_walk_state(false)  # a new plan arrived while walking: back to the map (keep the new layout)
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
	interior.build(Store.furniture if Store.guest_allowed.is_empty() else Store.furniture.filter(func(f):
		if f.get("kind", "") == "door":
			return Store.door_open(f)
		var r: Dictionary = Store.room_at(Vector2(float(f.x), float(f.z)))
		return r.is_empty() or Store.room_allowed(r.key)))
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
	if Store.guest_token != "" and not _walk_build and not Store.guest.is_empty():
		_start_guest.call_deferred()


## Every device shows its live state in the room (lights, airflow, screens, blinds...).
func _apply_live() -> void:
	if world == null:
		return
	for id in devices:
		var n = devices[id]
		if is_instance_valid(n):
			n.apply_live(Store.live.get(id, {}))
	_room_light()


var _amb_tw: Tween


## Walking: how bright the room looks follows its own lights (off is dim, full is bright), and the blinds let
## daylight in. Rooms without connected lights keep the normal level.
func _room_light() -> void:
	if walker == null or env == null:
		return
	var levels: Array = []
	var day := 0.0
	for d in Store.devices:
		if d.room != walker.room_key:
			continue
		var l: Dictionary = Store.live.get(d.id, {})
		if l.get("online", true) == false:
			if d.type == "light":
				levels.append(0.0)
			continue
		if d.type == "light":
			levels.append(float(l.get("lv", 0.0)) / 100.0)
		elif d.type == "blinds":
			day = maxf(day, float(l.get("pos", 0.0)) / 100.0)
		elif d.type == "tv" and bool(l.get("on", false)):
			day = maxf(day, 0.15)
	var target := WALK_AMBIENT
	if not levels.is_empty():
		var avg: float = levels.reduce(func(a, b): return a + b, 0.0) / levels.size()
		target = 0.14 + 0.42 * avg + 0.15 * day
	if _amb_tw:
		_amb_tw.kill()
	_amb_tw = create_tween()
	_amb_tw.tween_property(env, "ambient_light_energy", target, 1.2)


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
	_apply_live.call_deferred()


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
	var piping_focus := piping.focused
	var piping_trace := piping.traced
	world.get_node("Devices").free()
	piping.free()
	devices.clear()
	_make_devices()
	piping.visible = piping_on
	piping.focused = piping_focus
	piping.trace(piping_trace)
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
		var tw := n.create_tween()  # bound to the device: dropped with it if the floor is rebuilt meanwhile
		tw.tween_interval(1.4 + 0.02 * i)
		tw.tween_callback(func(): n.visible = detail == null or detail.device == null or detail.device == n)
		tw.tween_property(n, "position:y", y, 0.45).set_trans(Tween.TRANS_BOUNCE).set_ease(Tween.EASE_OUT)
		i += 1
	get_tree().create_timer(1.6 + 0.02 * i).timeout.connect(func():
		if is_instance_valid(piping) and is_instance_valid(detail):
			piping.visible = detail.device == null)
	get_tree().create_timer(1.0).timeout.connect(func():
		if walker == null:
			rig.reset(1.8))


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
	env = Environment.new()
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
	if world == null or Store.guest_token != "":
		return
	if walker:
		stop_walk(false)  # the twin opens on the map
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
	if e is InputEventMouseButton and e.button_index == MOUSE_BUTTON_LEFT and not e.pressed and e.device != InputEvent.DEVICE_ID_EMULATION:
		_room_click(e.position)
	elif e is InputEventScreenTouch and not e.pressed and e.index == 0:
		_room_click(e.position)
	if e.is_action_pressed("toggle_piping"):
		piping.visible = not piping.visible
	elif e.is_action_pressed("back"):
		if walker:
			if Store.guest_token == "":
				stop_walk()
		elif placer and placer.active():
			placer.cancel()
		elif detail.device:
			_on_close()
		else:
			Bus.highlight_cleared.emit()
			rig.reset()


var _device_click_ms := 0


## A click on a room's floor (not a device, not a drag) selects the room: the page offers to walk there
## or to make a guest QR code for it.
func _room_click(screen: Vector2) -> void:
	if world == null or walker or placer.active() or detail.device or CameraRig.drag_px > 6.0:
		return
	var hit = Placer.pointer_floor(rig.cam, screen)
	if hit == null:
		return
	var r: Dictionary = Store.room_at(hit)
	var at := Time.get_ticks_msec()
	await get_tree().create_timer(0.18).timeout
	if _device_click_ms >= at - 30 or world == null:
		return  # the click was on a device
	floor_builder.select_room(r.get("key", ""))
	Bridge.emit_event({"type": "roomClicked", "room": r.get("key", ""), "roomName": Store.room_label(r) if not r.is_empty() else ""})


# --- Walk-through ---------------------------------------------------------------------------------------

func _on_walk(action: String, msg: Dictionary) -> void:
	match action:
		"start": start_walk(str(msg.get("room", "")))
		"stop":
			if Store.guest_token == "":
				stop_walk()
		"skip": _guest_skip()
		"restart": _guest_restart(str(msg.get("from", "")))
		"overview":
			if walker:
				walker.overview(bool(msg.get("on", true)))
		"look":
			if walker and devices.has(str(msg.get("id", ""))):
				walker.look_at_point(devices[str(msg.get("id", ""))].global_position)
				_on_highlight([str(msg.get("id", ""))], "")
		"toggle":
			if Store.guest_token != "":
				return
			if walker:
				stop_walk()
			else:
				start_walk(str(msg.get("room", "")))
		"goto":
			if walker == null:
				start_walk(str(msg.get("room", "")))
			elif not walker.go_to_room(str(msg.get("room", ""))):
				Bridge.emit_event({"type": "walk", "on": true, "room": walker.room_key, "roomName": Store.room_label(Store.room_at(walker.p)), "note": "No way in from here"})
		"stick":
			if walker:
				walker.joy = Vector2(float(msg.get("x", 0)), float(msg.get("y", 0))).limit_length(1.0)


## Steps into the floor: walls grow to full height with ceilings and lintels, doorways are added to rooms
## the plan left closed, and the camera drops from the map view to eye height where the view was centred.
func start_walk(room_key := "") -> void:
	if world == null or walker:
		return
	_on_close()
	if placer.active():
		placer.cancel()
	var from := rig.cam.global_transform
	var fwd := -from.basis.z
	var look_yaw := atan2(-fwd.x, -fwd.z)
	var start = Placer.pointer_floor(rig.cam, get_viewport().get_visible_rect().size / 2)
	if start == null or Store.room_at(start).is_empty():
		start = Vector2(rig.target.x, rig.target.z)
	if Store.room_at(start).is_empty():
		start = _busiest_room_point()
	if room_key != "" and not Store.room(room_key).is_empty():
		start = PlanGeo.interior_point(PlanGeo.room_poly(Store.room(room_key)))
	_walk_saved = {"h": Store.wall_height, "furniture": Store.furniture}
	Store.walk = true
	Store.wall_height = WALK_HEIGHT
	Store.furniture = Store.furniture + WalkNav.auto_doors(Store.rooms, Store.furniture)
	_walk_build = true
	_build_world(false)
	_walk_build = false
	rig.set_process_unhandled_input(false)
	env.ambient_light_energy = WALK_AMBIENT
	sun.light_energy = 0.25
	walker = Walker.new()
	walker.name = "Walker"
	world.add_child(walker)
	walker.landed.connect(func():
		if is_instance_valid(floor_builder) and floor_builder.ceilings:
			floor_builder.ceilings.visible = true)
	walker.begin(floor_builder.wall_pieces, floor_builder.lintels, start, look_yaw, from)
	walker._track_room()


## Back to the map, looking down at where the walk ended.
func stop_walk(fly := true) -> void:
	if walker == null:
		return
	var p := walker.p
	var y := walker.yaw
	_end_walk_state()
	_walk_build = true
	_build_world(false)
	_walk_build = false
	rig.jump(Vector3(p.x, 0, p.y), 2.5, deg_to_rad(-12.0), y)
	if fly:
		rig.fly_to(Vector3(p.x, 0, p.y), clampf(rig.home_distance * 0.45, 8.0, 40.0), deg_to_rad(-52.0), y, 1.3)


func _end_walk_state(restore := true) -> void:
	if walker == null:
		return
	walker = null
	if Store.walk:
		Store.walk = false
		if restore and _walk_saved.has("h"):
			Store.wall_height = _walk_saved.h
			Store.furniture = _walk_saved.furniture
	_walk_saved = {}
	rig.set_process_unhandled_input(true)
	rig.cam.current = true
	env.ambient_light_energy = 0.55
	sun.light_energy = SUN
	Bus.walk_changed.emit({"on": false})


## Inside the room with the most doors (usually the corridor), for when the view points at nothing.
func _busiest_room_point() -> Vector2:
	var best: Dictionary = Store.rooms[0]
	var most := -1
	for r in Store.rooms:
		var poly := PlanGeo.room_poly(r)
		var n := 0
		for f in Store.furniture:
			if f.get("kind", "") == "door":
				var c := Vector2(float(f.x), float(f.z))
				for i in poly.size():
					if c.distance_to(Geometry2D.get_closest_point_to_segment(c, poly[i], poly[(i + 1) % poly.size()])) < 0.3:
						n += 1
						break
		if n > most:
			most = n
			best = r
	return PlanGeo.interior_point(PlanGeo.room_poly(best))


# --- Guest visit (opened from a room's QR code) ---------------------------------------------------------

var _guest_target := Vector2.INF
var _guest_room := ""
var _guest_from := ""


## The guest walks from the entrance to their room. Only rooms on that way (and the room itself) are
## open: their doors stand open and their furniture is shown; every other door stays shut and other
## rooms show no names, furniture or devices (the platform sends only the guest room's devices).
## On arrival the guest is kept inside their room.
func _start_guest(from_key := "") -> void:
	if walker or world == null:
		return
	_guest_room = str(Store.guest.get("room", ""))
	var target_room: Dictionary = Store.room(_guest_room)
	if target_room.is_empty():
		return
	if from_key != "":
		Store.guest["entrance"] = from_key
	_walk_saved = {"h": Store.wall_height, "furniture": Store.furniture}
	Store.guest_allowed = {}
	Store.walk = true
	Store.wall_height = WALK_HEIGHT
	Store.furniture = Store.furniture + WalkNav.auto_doors(Store.rooms, Store.furniture)
	_walk_build = true
	_build_world(false)
	# plan the way on the whole floor, then open only the rooms it passes through
	var nav := WalkNav.new()
	nav.build(floor_builder.wall_pieces, floor_builder.lintels)
	var start := _guest_entrance(nav, target_room)
	_guest_target = nav.room_target(target_room, start)
	var allowed := {_guest_room: true}
	var from_room: Dictionary = Store.room_at(start)
	if not from_room.is_empty():
		allowed[from_room.key] = true
		_guest_from = Store.room_label(from_room)
	else:
		_guest_from = "Entrance"
	var route := nav.path(start, _guest_target) if _guest_target != Vector2.INF else PackedVector2Array()
	var prev := start
	for q in route:
		for k in 8:
			var r: Dictionary = Store.room_at(prev.lerp(q, k / 8.0))
			if not r.is_empty():
				allowed[r.key] = true
		prev = q
	Store.guest_allowed = allowed
	_build_world(false)
	_walk_build = false
	rig.set_process_unhandled_input(false)
	env.ambient_light_energy = WALK_AMBIENT
	sun.light_energy = 0.25
	walker = Walker.new()
	walker.name = "Walker"
	world.add_child(walker)
	walker.landed.connect(func():
		if is_instance_valid(floor_builder) and floor_builder.ceilings:
			floor_builder.ceilings.visible = true)
	var look := 0.0
	if route.size() > 0:
		var d := route[0] - start
		look = atan2(-d.x, -d.y)
	walker.begin(floor_builder.wall_pieces, floor_builder.lintels, start, look, rig.cam.global_transform)
	walker.arrived.connect(_guest_arrived)
	walker.show_route(start, route, Store.room_label(target_room))
	walker._track_room()
	var metres := 0.0
	prev = start
	for q in route:
		metres += prev.distance_to(q)
		prev = q
	Bus.walk_changed.emit({"on": true, "guest": "walking", "from": _guest_from, "to": Store.room_label(target_room), "metres": snappedf(metres, 0.1)})
	get_tree().create_timer(Walker.INTRO + 0.3).timeout.connect(func():
		if walker and _guest_target != Vector2.INF and not walker.go_to(_guest_target):
			_guest_skip())


## Where a guest's walk begins: the entrance the host chose; else just inside a door to the outside;
## else a lift, lobby, reception or stair; else the best-connected room (usually the corridor).
func _guest_entrance(nav: WalkNav, target_room: Dictionary) -> Vector2:
	var chosen: Dictionary = Store.room(str(Store.guest.get("entrance", "")))
	if not chosen.is_empty():
		var p := nav.room_target(chosen, PlanGeo.interior_point(PlanGeo.room_poly(target_room)))
		if p != Vector2.INF:
			return p
	var goal := PlanGeo.interior_point(PlanGeo.room_poly(target_room))
	var best := Vector2.INF
	var best_len := INF
	for f in Store.furniture:
		if f.get("kind", "") != "door":
			continue
		var c := Vector2(float(f.x), float(f.z))
		var rot := float(f.get("rot", 0.0))
		var n := Vector2(sin(rot), cos(rot))
		for side in [1.0, -1.0]:
			if Store.room_at(c + n * side * 0.45).is_empty() and not Store.room_at(c - n * side * 0.45).is_empty():
				var inside := nav.nearest_free(c - n * side * 0.8, 6)
				var route := nav.path(inside, goal, false)
				if route.size() > 0 and route.size() < best_len:
					best_len = route.size()
					best = inside
	if best != Vector2.INF:
		return best
	var re := RegEx.create_from_string("(?i)lift|elevator|lobby|reception|entrance|entry|foyer")
	var stairs := RegEx.create_from_string("(?i)stair")
	for pass_re in [re, stairs]:
		best_len = INF
		for r in Store.rooms:
			if pass_re.search(str(r.name) + " " + str(r.get("label", ""))) == null or r.key == target_room.key:
				continue
			var p := nav.room_target(r, goal)
			if p == Vector2.INF:
				continue
			var route := nav.path(p, goal, false)
			if route.size() > 0 and route.size() < best_len:
				best_len = route.size()
				best = p
		if best != Vector2.INF:
			return best
	return nav.nearest_free(_busiest_room_point(), 200)


func _guest_arrived() -> void:
	if walker == null or _guest_room == "" or walker.room_key != _guest_room:
		return
	walker.confine(Store.room(_guest_room))
	walker.hide_route()
	Bus.walk_changed.emit({"on": true, "guest": "arrived", "room": _guest_room, "roomName": Store.room_label(Store.room(_guest_room))})


## The guest chose another starting point: plan the way again from there.
func _guest_restart(from_key: String) -> void:
	if Store.guest_token == "" or walker == null:
		return
	walker = null
	Store.walk = false
	Store.guest_allowed = {}
	if _walk_saved.has("h"):
		Store.wall_height = _walk_saved.h
		Store.furniture = _walk_saved.furniture
	_start_guest(from_key)


## Straight into the room (the guest skipped the walk).
func _guest_skip() -> void:
	if walker == null or _guest_target == Vector2.INF:
		return
	walker.teleport(_guest_target)
	walker._track_room()
	_guest_arrived()
