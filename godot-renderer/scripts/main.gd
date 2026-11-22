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
var quality: Quality
var xp: ExperienceLayer   # comfort, energy, ops beacons, technician route, arrival auras
var _layers := {"comfort": false, "energy": false, "ops": true}
var _welcomed := {}       # room -> journey state already welcomed on the TV
var walker: Walker        # first-person walk-through, or null on the map
var _walk_saved := {}     # map wall height and plan furniture, restored when the walk ends
var _walk_build := false  # the world is being rebuilt to enter or leave the walk
const WALK_HEIGHT := 2.7  # metres, floor to ceiling while walking
const WALK_AMBIENT := 0.5  # low enough that the room's own lights (and switching them) show


func _ready() -> void:
	get_viewport().physics_object_picking = true
	_environment()
	quality = Quality.new()
	quality.name = "Quality"
	quality.env = env
	quality.sun = sun
	add_child(quality)
	Bus.quality_requested.connect(quality.request)
	Bus.daylight_requested.connect(func(hr: float):
		_day_hour = hr
		_apply_daylight())
	var clock := Timer.new()   # daylight follows the time of day
	clock.wait_time = 60.0
	clock.autostart = true
	clock.timeout.connect(_apply_daylight)
	add_child(clock)
	_apply_daylight.call_deferred()
	Bus.experience_updated.connect(_on_experience)
	Bus.dispatch_requested.connect(func(id):
		if xp:
			xp.dispatch(id))
	Bus.welcome_requested.connect(func(m): _welcome(str(m.get("room", "")), str(m.get("guest", "")), str(m.get("state", "ready"))))
	rig = CameraRig.new()
	add_child(rig)
	_hud()
	# Wait for the platform's layout so the bundled sample never flashes up first. Fall back to the
	# bundled sample only when the platform can't be reached (offline desktop run) or after 20 s.
	Bus.layout_changed.connect(_on_layout)
	Bus.devices_changed.connect(_rebuild_devices)
	Store.platform_unreachable.connect(func():
		if world == null and Store.guest_token == "":
			_build_world(true))
	get_tree().create_timer(20.0).timeout.connect(func():
		if world == null and Store.guest_token == "":
			_build_world(true))

	Bus.health_changed.connect(_on_health)
	Bus.live_updated.connect(_apply_live)
	Bus.preview_requested.connect(_on_preview)
	Bus.story_requested.connect(_on_story)
	Bus.track_requested.connect(func(id): _track = id; _anchor_t = 0.0; _holo(id))
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
		if a.begins_with("--zone-shots="):
			var zs := Node.new()
			zs.set_script(load("res://tests/zone_shots.gd"))
			add_child(zs)
		if a.begins_with("--fx-shots="):
			var fs := Node.new()
			fs.set_script(load("res://tests/fx_shots.gd"))
			add_child(fs)
		if a.begins_with("--live-check="):
			var lt := Node.new()
			lt.set_script(load("res://tests/live_test.gd"))
			add_child(lt)
		if a.begins_with("--guest-check="):
			var gt := Node.new()
			gt.set_script(load("res://tests/guest_test.gd"))
			add_child(gt)
		if a.begins_with("--guest-stress="):
			var gs := Node.new()
			gs.set_script(load("res://tests/guest_stress.gd"))
			add_child(gs)
		if a.begins_with("--walk="):
			var wt := Node.new()
			wt.set_script(load("res://tests/walk_test.gd"))
			add_child(wt)
		if a.begins_with("--lift-shots="):
			var ls := Node.new()
			ls.set_script(load("res://tests/lift_shots.gd"))
			add_child(ls)
		if a == "--live-check":
			var lc := Node.new()
			lc.set_script(load("res://tests/live_check.gd"))
			add_child(lc)
		if a.begins_with("--navmap="):
			var nm := Node.new()
			nm.set_script(load("res://tests/nav_map.gd"))
			add_child(nm)
		if a.begins_with("--routes="):
			var rc := Node.new()
			rc.set_script(load("res://tests/route_check.gd"))
			add_child(rc)
		if a.begins_with("--camera="):
			var ct := Node.new()
			ct.set_script(load("res://tests/camera_test.gd"))
			add_child(ct)
		if a.begins_with("--xp-shots="):
			var xs := Node.new()
			xs.set_script(load("res://tests/experience_shots.gd"))
			add_child(xs)
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
	xp = ExperienceLayer.new()
	world.add_child(xp)
	xp.comfort_on = _layers.comfort
	xp.energy_on = _layers.energy
	xp.ops_on = _layers.ops
	xp.setup(self)
	var fr: Rect2 = Store.floor_rect()
	rig.set_bounds(fr)  # zoom range, pan limits and the home view follow the floor's size
	_on_time(Store.t)
	if animate:
		_play_plan_to_3d()
	Bridge.emit_event({"type": "floorBuilt", "rooms": Store.rooms.size(), "devices": Store.devices.size()})
	if Store.guest_token != "" and not _walk_build and not Store.guest.is_empty():
		_start_guest.call_deferred()


var _rooms_sig := ""


## A new layout: a new plan plays the plan-to-3D build; the same rooms with changed furniture just rebuild in
## place (the view and the selected room stay).
func _on_layout() -> void:
	var sig := str(JSON.stringify(Store.rooms).hash())
	var same := world != null and sig == _rooms_sig
	_rooms_sig = sig
	if Store.guest_token != "":
		_build_world(false)
		return
	if same and walker == null:
		var sel := floor_builder._selected if floor_builder else ""
		_build_world(false)
		if sel != "":
			floor_builder.select_room(sel)
		return
	_build_world(not same)


## Every device shows its live state in the room (lights, airflow, screens, blinds...).
var _locks_sig := ""

func _apply_live() -> void:
	if world == null:
		return
	_apply_locks()
	if _live:
		_live_fix()
	for id in devices:
		var n = devices[id]
		if is_instance_valid(n):
			n.apply_live(_live_of(id))
	_room_light()


# ---- story mode (web/app/story): the host page plays a guest's night on the floor in chapters and drives the
# renderer with {type: "story", action: ...}

var _story_tv := {}    # device id -> Label3D welcome text on its screen
var _heat: Node3D      # room overlay (energy or occupancy)
var _night_on := false


func _on_story(msg: Dictionary) -> void:
	if world == null:
		return
	match str(msg.get("action", "")):
		"build":  # replay the plan-to-3D build
			if walker:
				stop_walk(false)
			_build_world(true)
		"shot":  # a cinematic camera move: target [x, z], distance, pitch and yaw in degrees, seconds
			var t: Array = msg.get("target", [rig.target.x, rig.target.z])
			rig.fly_to(Vector3(float(t[0]), 0, float(t[1])), float(msg.get("distance", rig.distance)),
				deg_to_rad(float(msg.get("pitch", rad_to_deg(rig.pitch)))), deg_to_rad(float(msg.get("yaw", rad_to_deg(rig.yaw)))), float(msg.get("secs", 2.5)))
		"room":  # frame a room from above at an angle
			var r: Dictionary = Store.room(str(msg.get("room", "")))
			if not r.is_empty():
				var c := PlanGeo.interior_point(PlanGeo.room_poly(r))
				var span := maxf(float(r.x[1]) - float(r.x[0]), float(r.z[1]) - float(r.z[0]))
				rig.fly_to(Vector3(c.x, 0, c.y), clampf(span * 1.6, 7.0, 30.0), deg_to_rad(float(msg.get("pitch", -48.0))),
					deg_to_rad(float(msg.get("yaw", rad_to_deg(rig.yaw)))), float(msg.get("secs", 2.2)))
		"wave":  # live data reaching every device, swept across the floor
			_story_wave(float(msg.get("secs", 3.0)))
		"walk":  # a guest (by lift) or a technician (from a room) walks to a room, first person
			if walker:
				stop_walk(false)
			Store.guest = {"room": str(msg.get("room", "")), "entrance": str(msg.get("from", ""))}
			_start_guest()
		"endWalk":
			if walker:
				stop_walk(bool(msg.get("fly", true)))
			Store.guest = {}
			Store.guest_allowed = {}
		"tv":  # text on a TV's screen (the welcome message); empty text clears it
			_story_tv_text(str(msg.get("id", "")), str(msg.get("text", "")), str(msg.get("sub", "")))
		"heat":  # colour each room by a value 0..1 with a label; {on: false} clears
			_story_heat(msg.get("values", {}) if msg.get("values") is Dictionary else {}, msg.get("labels", {}) if msg.get("labels") is Dictionary else {}, bool(msg.get("on", true)))
		"night":
			_story_night(bool(msg.get("on", true)))
		"cast":  # the story's guest: other stays on the floor are not drawn while the story plays
			Store.story_guest = str(msg.get("guest", ""))
			if xp:
				xp.refresh()


func _story_wave(secs: float) -> void:
	var ids: Array = devices.keys()
	if ids.is_empty():
		return
	var minx := INF
	var maxx := -INF
	for id in ids:
		var x: float = devices[id].global_position.x
		minx = minf(minx, x)
		maxx = maxf(maxx, x)
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	m.albedo_color = Color(0.35, 0.75, 1.0, 0.0)
	for id in ids:
		var n: Node3D = devices[id]
		var delay := (n.global_position.x - minx) / maxf(maxx - minx, 0.1) * secs
		var beam := MeshInstance3D.new()
		var cm := CylinderMesh.new()
		cm.top_radius = 0.02
		cm.bottom_radius = 0.18
		cm.height = 3.0
		beam.mesh = cm
		var bm := m.duplicate() as StandardMaterial3D
		beam.material_override = bm
		beam.position = n.global_position + Vector3(0, 1.4, 0)
		world.add_child(beam)
		var tw := beam.create_tween()
		tw.tween_interval(delay)
		tw.tween_property(bm, "albedo_color:a", 0.85, 0.25)
		tw.parallel().tween_property(beam, "scale", Vector3(1.6, 1, 1.6), 0.25)
		tw.tween_property(bm, "albedo_color:a", 0.0, 0.9)
		tw.tween_callback(beam.queue_free)
		get_tree().create_timer(delay + 0.1).timeout.connect(func():
			if is_instance_valid(n):
				n.set_highlight(true, false)
				get_tree().create_timer(1.2).timeout.connect(func():
					if is_instance_valid(n) and not _highlight.has(id):
						n.set_highlight(false, false)))


func _story_tv_text(id: String, text: String, sub: String) -> void:
	if _story_tv.has(id) and is_instance_valid(_story_tv[id]):
		_story_tv[id].queue_free()
	_story_tv.erase(id)
	if text == "" or not devices.has(id):
		return
	var n: Node3D = devices[id]
	var l := Label3D.new()
	l.text = text + ("\n" + sub if sub != "" else "")
	l.font_size = 40
	l.pixel_size = 0.0016
	l.outline_size = 14
	l.outline_modulate = Color(0.04, 0.07, 0.16)
	l.modulate = Color(1, 1, 1)
	l.position = Vector3(0, 0.02, 0.06)
	var back := MeshInstance3D.new()  # dark card behind the text so it reads on a bright screen
	var q := QuadMesh.new()
	q.size = Vector2(0.95, 0.42)
	back.mesh = q
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.albedo_color = Color(0.05, 0.09, 0.22)
	back.material_override = m
	back.position = Vector3(0, 0, -0.004)
	l.add_child(back)
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	n.add_child(l)
	_story_tv[id] = l


func _story_heat(values: Dictionary, labels: Dictionary, on: bool) -> void:
	if _heat and is_instance_valid(_heat):
		_heat.queue_free()
	_heat = null
	if not on or values.is_empty():
		return
	_heat = Node3D.new()
	_heat.name = "StoryHeat"
	world.add_child(_heat)
	for k in values:
		var r: Dictionary = Store.room(str(k))
		if r.is_empty():
			continue
		var v := clampf(float(values[k]), 0.0, 1.0)
		var col := Color(0.2, 0.75, 0.45).lerp(Color(0.98, 0.75, 0.2), minf(v * 2.0, 1.0)).lerp(Color(0.95, 0.3, 0.25), maxf(v * 2.0 - 1.0, 0.0))
		col.a = 0.5
		var poly := PlanGeo.room_poly(r)
		var tris := Geometry2D.triangulate_polygon(poly)
		var st := SurfaceTool.new()
		st.begin(Mesh.PRIMITIVE_TRIANGLES)
		for i in tris:
			st.add_vertex(Vector3(poly[i].x, 0.06, poly[i].y))
		var mi := MeshInstance3D.new()
		mi.mesh = st.commit()
		var m := StandardMaterial3D.new()
		m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		m.cull_mode = BaseMaterial3D.CULL_DISABLED
		m.albedo_color = Color(col.r, col.g, col.b, 0.0)
		mi.material_override = m
		_heat.add_child(mi)
		mi.create_tween().tween_property(m, "albedo_color:a", col.a, 0.8)
		if labels.has(k):
			var c := PlanGeo.interior_point(poly)
			var l := Label3D.new()
			l.text = str(labels[k])
			l.billboard = BaseMaterial3D.BILLBOARD_ENABLED
			l.fixed_size = true
			l.pixel_size = 0.0011
			l.font_size = 44
			l.outline_size = 12
			l.outline_modulate = Color(0, 0, 0, 0.8)
			l.no_depth_test = true
			l.position = Vector3(c.x, 1.6, c.y)
			_heat.add_child(l)


func _story_night(on: bool) -> void:
	_night_on = on
	var tw := create_tween().set_parallel(true)
	tw.tween_property(env, "background_color", Color("05070c") if on else Color("0b0e12"), 1.5)
	tw.tween_property(env, "ambient_light_color", Color("4a5a80") if on else Color("aab4c3"), 1.5)
	tw.tween_property(env, "ambient_light_energy", 0.22 if on else 0.55, 1.5)
	tw.tween_property(sun, "light_energy", 0.02 if on else SUN, 1.5)
	tw.tween_property(env, "glow_intensity", 1.2 if on else 0.6, 1.5)
	if not on:
		get_tree().create_timer(1.6).timeout.connect(_apply_daylight)


# ---- 3D device control for guests: previews while a control is dragged, a pinned anchor, a hologram value --------

var _preview := {}       # id -> {readings, until}
var _track := ""         # device whose screen position is reported to the host
var _anchor_t := 0.0
var _last_anchor := ""
var _holo_node: Node3D
var _holo_label: Label3D
var _holo_ring: MeshInstance3D


func _live_of(id: String) -> Dictionary:
	var l: Dictionary = Store.live.get(id, {})
	var p: Dictionary = _preview.get(id, {})
	if p.is_empty() or Time.get_ticks_msec() > int(p.until):
		_preview.erase(id)
		return l
	return l.merged(p.readings, true)


func _on_preview(id: String, readings: Dictionary, text: String) -> void:
	if not devices.has(id):
		return
	_preview[id] = {"readings": readings, "until": Time.get_ticks_msec() + 4000}
	devices[id].apply_live(_live_of(id))
	_room_light()
	if text != "" and _holo_label:
		_holo_label.text = text
		_holo_label.modulate.a = 1.0
		var tw := _holo_label.create_tween()
		tw.tween_interval(1.4)
		tw.tween_property(_holo_label, "modulate:a", 0.0, 0.6)


## A slowly turning ring of light around the device the guest is controlling, and a floating value over it.
func _holo(id: String) -> void:
	if _holo_node and is_instance_valid(_holo_node):
		_holo_node.queue_free()
	_holo_node = null
	if id == "" or not devices.has(id) or world == null:
		return
	var n: Node3D = devices[id]
	_holo_node = Node3D.new()
	_holo_node.name = "ControlHolo"
	world.add_child(_holo_node)
	_holo_node.global_position = n.global_position
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.albedo_color = Color(0.45, 0.75, 1.0, 0.75)
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.no_depth_test = true
	m.render_priority = 3
	_holo_ring = MeshInstance3D.new()
	var tm := TorusMesh.new()
	var size: Vector3 = DeviceNode.body_size(n.data)
	var r := clampf(maxf(size.x, size.z) * 0.7 + 0.12, 0.2, 1.3)
	tm.inner_radius = r
	tm.outer_radius = r + 0.025
	tm.rings = 48
	_holo_ring.mesh = tm
	_holo_ring.material_override = m
	_holo_node.add_child(_holo_ring)
	_holo_label = Label3D.new()
	_holo_label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	_holo_label.no_depth_test = true
	_holo_label.fixed_size = true
	_holo_label.pixel_size = 0.0009
	_holo_label.font_size = 64
	_holo_label.outline_size = 14
	_holo_label.outline_modulate = Color(0.02, 0.05, 0.12, 0.9)
	_holo_label.modulate = Color(0.75, 0.9, 1.0, 0.0)
	_holo_label.position.y = maxf(size.y * 0.5, 0.1) + 0.28
	_holo_node.add_child(_holo_label)


func _process(delta: float) -> void:
	_track_tick(delta)


## New experience data from the platform: the layers follow it, and a guest's room welcomes them on its TV when
## their room becomes ready and when they arrive.
func _on_experience() -> void:
	if world == null or xp == null:
		return
	xp.refresh()
	if Store.guest_token == "":
		return
	for j in Store.experience.get("journeys", []):
		var st := str(j.get("state", ""))
		if st in ["ready", "arrived"] and _welcomed.get(str(j.room), "") != st:
			_welcomed[str(j.room)] = st
			_welcome(str(j.room), str(j.get("guest", "")), st)


## The welcome moment: the room's TV greets the guest by name and the room's lights pulse once.
func _welcome(room: String, guest: String, state: String) -> void:
	var tv := ""
	for d in Store.devices:
		if d.room == room and d.type == "tv":
			tv = d.id
			break
	if tv == "":
		return
	var first := guest.split(" ")[0] if guest != "" else ""
	var line := ("Welcome, %s" % first) if first != "" else "Welcome"
	var sub := "Your room is ready" if state == "ready" else "Enjoy your stay"
	var c: Dictionary = Store.experience.get("comfort", {}).get(room, {})
	if not c.is_empty():
		sub += "  ·  %.1f °C" % float(c.get("temp", 0))
	_story_tv_text(tv, line, sub)
	for d in Store.devices:
		if d.room == room and devices.has(d.id) and d.type == "light":
			devices[d.id].set_highlight(true, false)
			get_tree().create_timer(1.6).timeout.connect(func():
				if devices.has(d.id):
					devices[d.id].set_highlight(false, false))


func _track_tick(delta: float) -> void:
	if _holo_ring and is_instance_valid(_holo_ring):
		_holo_ring.rotation.y += delta * 0.8
		var k := 1.0 + 0.06 * sin(Time.get_ticks_msec() / 300.0)
		_holo_ring.scale = Vector3(k, 1, k)
	if _track == "":
		return
	_anchor_t -= delta
	if _anchor_t > 0.0:
		return
	_anchor_t = 0.08
	var cam := get_viewport().get_camera_3d()
	if cam == null or not devices.has(_track):
		return
	var p: Vector3 = devices[_track].global_position
	var vis := not cam.is_position_behind(p)
	var sp := cam.unproject_position(p)
	var vs := get_viewport().get_visible_rect().size
	var ev := {"type": "anchor", "id": _track, "x": snappedf(sp.x / vs.x, 0.001), "y": snappedf(sp.y / vs.y, 0.001), "visible": vis and sp.x >= 0 and sp.y >= 0 and sp.x <= vs.x and sp.y <= vs.y}
	var key := JSON.stringify(ev)
	if key != _last_anchor:
		_last_anchor = key
		Bridge.emit_event(ev)


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
			day = maxf(day, float(l.get("pos", 0.0)) / 100.0 * _daylight())   # an open curtain lets in only what daylight there is
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
	env.adjustment_enabled = true
	env.adjustment_contrast = 1.06
	env.adjustment_saturation = 1.08
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
	_readable(hud, 1.0)
	layer.add_child(hud)
	legend = Label.new()
	legend.position = Vector2(14, 34)
	_readable(legend, 0.95)
	layer.add_child(legend)
	if OS.has_feature("web"):
		# the page shows the clock and its own panels on the left; keep only the flow legend, clear of the palette
		hud.visible = false
		legend.position = Vector2(270, 16)
	if not OS.has_feature("web"):
		var help := Label.new()
		help.text = "Click a device to focus · double-click to open · P piping · Esc back · drag orbit · right-drag pan · wheel zoom"
		_readable(help, 0.85)
		help.anchor_top = 1.0
		help.anchor_bottom = 1.0
		help.position = Vector2(14, -30)
		layer.add_child(help)


## Light text on a dark outline reads over both the daylight floor and the night view.
func _readable(l: Label, alpha: float) -> void:
	l.add_theme_color_override("font_color", Color(0.96, 0.97, 1.0, alpha))
	l.add_theme_color_override("font_outline_color", Color(0.04, 0.06, 0.1, 0.9))
	l.add_theme_constant_override("outline_size", 6)
	l.add_theme_font_size_override("font_size", 17)


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
	_mark(ids)
	if ids.size() == 1:
		_on_focus(ids[0])
	elif ids.size() > 1:
		var box := AABB(devices[ids[0]].global_position, Vector3.ZERO) if devices.has(ids[0]) else AABB()
		for id in ids:
			if devices.has(id):
				box = box.expand(devices[id].global_position)
		rig.fly_to(box.get_center(), clampf(box.size.length() * 1.3 + 4.0, 6.0, 22.0))


## Rings the devices without moving the view (a tour stop that already stands where the device is seen).
func _mark(ids: Array) -> void:
	_highlight = ids
	for id in devices:
		devices[id].set_highlight(ids.has(id), not ids.is_empty())


func _on_focus(id: String) -> void:
	if world == null:
		return
	if devices.has(id) and walker:
		_show_device(id)   # walking: go where it can be seen (the agent's "show me", a technician at the unit)
	elif devices.has(id):
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
	if xp:
		xp.visible = false    # beacons, routes and overlays step back too
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
	if xp:
		xp.visible = true
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
			Store.show_ids = on
			for id in devices:
				devices[id].show_label(on)
		"temperature": floor_builder.tint_rooms(on)
		"furniture": interior.visible = on
		"exploded": detail.set_exploded(on)
		"comfort":
			_layers.comfort = on
			xp.set_comfort(on)
		"energy":
			_layers.energy = on
			xp.set_energy(on)
		"ops":
			_layers.ops = on
			xp.set_ops(on)


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
		"live":
			_live = bool(msg.get("on", true))
			_fix_count = 0
			if walker:
				walker.set_live(_live)
				if _live:
					_live_fix()
		"stepFree":  # step-free route on or off: a guest still on the way is routed again from where they came in
			Store.step_free = bool(msg.get("on", true))
			if walker:
				if Store.guest_token != "" and not _guest_settled:
					_guest_restart(str(Store.guest.get("entrance", "")))   # builds a fresh walk (and its routes)
				else:
					walker.rebuild_nav()
		"overview":
			if walker:
				walker.overview(bool(msg.get("on", true)))
		"look":
			if walker and devices.has(str(msg.get("id", ""))):
				walker.look_at_point(devices[str(msg.get("id", ""))].global_position)
				_on_highlight([str(msg.get("id", ""))], "")
		"show":  # guided tour: go where the device can be seen, face it, then say so (the host opens its control)
			if walker and devices.has(str(msg.get("id", ""))):
				_show_device(str(msg.get("id", "")))
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
				var shut: Array = walker.nav.locked_names()
				var why := ("Locked: " + ", ".join(shut)) if not shut.is_empty() else "No way in from here"
				Bridge.emit_event({"type": "walk", "on": true, "room": walker.room_key, "roomName": Store.room_label(Store.room_at(walker.p)), "note": why})
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
		# step in through the room's door and look across the room, the way you would on entering it
		var entry := _room_entry(Store.room(room_key))
		start = entry[0]
		look_yaw = entry[1]
	_walk_saved = {"h": Store.wall_height, "furniture": Store.furniture}
	Store.walk = true
	Store.wall_height = WALK_HEIGHT
	Store.furniture = Store.furniture + WalkNav.auto_doors(Store.rooms, Store.furniture)
	_walk_build = true
	_build_world(false)
	_walk_build = false
	rig.set_process_unhandled_input(false)
	env.ambient_light_energy = WALK_AMBIENT
	_walk_look(true)
	sun.light_energy = 0.25
	walker = Walker.new()
	walker.name = "Walker"
	world.add_child(walker)
	walker.landed.connect(func():
		if is_instance_valid(floor_builder) and floor_builder.ceilings:
			floor_builder.ceilings.visible = true)
	walker.begin(floor_builder.wall_pieces, floor_builder.lintels, start, look_yaw, from)
	walker._track_room()
	if room_key != "" and not Store.room(room_key).is_empty():
		var wk := walker
		walker.landed.connect(func(): if is_instance_valid(wk): wk.view_room(Store.room(room_key)), CONNECT_ONE_SHOT)


## Walking, the picture is graded like a photo of a lit interior: warm-neutral fill light instead of the map's cool
## blue, ACES tone mapping (highlights roll off instead of clipping), a soft glow round lamps, a touch of contrast.
func _walk_look(on: bool) -> void:
	env.ambient_light_color = Color("d8d0c4") if on else Color("aab4c3")
	env.tonemap_mode = Environment.TONE_MAPPER_ACES if on else Environment.TONE_MAPPER_FILMIC
	env.tonemap_exposure = 1.0
	env.tonemap_white = 6.0 if on else 1.0
	env.glow_intensity = 0.45 if on else 0.6
	env.glow_hdr_threshold = 1.2 if on else 1.0
	env.adjustment_enabled = on
	env.adjustment_contrast = 1.1
	env.adjustment_saturation = 1.04


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
	Store.key_room = ""
	_apply_locks(false)
	for f in Store.furniture:  # the arrival lift's doors and shaft go back to normal
		f.erase("arrival")
	if Store.walk:
		Store.walk = false
		if restore and _walk_saved.has("h"):
			Store.wall_height = _walk_saved.h
			Store.furniture = _walk_saved.furniture
	_walk_saved = {}
	rig.set_process_unhandled_input(true)
	rig.cam.current = true
	_apply_daylight()
	_walk_look(false)
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
var _live := false       # the guest's view follows their live indoor position
var _route_at := 0       # ms of the last route re-plan from the live position
var _last_fix := 0.0
var _fix_count := 0      # live fixes since live tracking was turned on
var _live_arrived := false
var _guest_room := ""
var _guest_from := ""


## The guest walks from the entrance to their room. Only rooms on that way (and the room itself) are
## open: their doors stand open and their furniture is shown; every other door stays shut and other
## rooms show no names, furniture or devices (the platform sends only the guest room's devices).
## On arrival the guest is kept inside their room.
func _start_guest(from_key := "") -> void:
	_guest_settled = false
	if walker or world == null:
		return
	_arrival_lift = {}
	_guest_room = str(Store.guest.get("room", ""))
	Store.key_room = _guest_room   # their pass (or work order) opens this room's lock
	_apply_locks(false)   # its door is drawn open for them (the world is rebuilt below)
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
	if not _arrival_lift.is_empty():
		# the lift the guest arrives in: an opening in the lobby wall, its own doors drawn moving, its shaft open
		_arrival_lift["arrival"] = true
		var lr := float(_arrival_lift.get("rot", 0.0))
		var wall_at := Vector2(float(_arrival_lift.x), float(_arrival_lift.z)) - Vector2(sin(lr), cos(lr)) * 0.09
		Store.furniture = Store.furniture + [{"kind": "door", "opening": true, "x": wall_at.x, "z": wall_at.y, "w": float(_arrival_lift.w), "d": 0.17, "rot": lr}]
		for f in Store.furniture:
			if f.get("kind", "") == "lift_shaft" and absf(float(f.x) - float(_arrival_lift.x)) < 0.3:
				f["arrival"] = true
	_build_world(false)
	_walk_build = false
	rig.set_process_unhandled_input(false)
	env.ambient_light_energy = WALK_AMBIENT
	_walk_look(true)
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
	if not _arrival_lift.is_empty():
		var lr := float(_arrival_lift.get("rot", 0.0))
		var wall_at := Vector2(float(_arrival_lift.x), float(_arrival_lift.z)) - Vector2(sin(lr), cos(lr)) * 0.09
		walker.arrive_by_lift(wall_at, lr, float(_arrival_lift.w), start, look)
	walker.show_route(start, route, Store.room_label(target_room))
	walker._track_room()
	var metres := 0.0
	prev = start
	for q in route:
		metres += prev.distance_to(q)
		prev = q
	var pts: Array = [[snappedf(start.x, 0.01), snappedf(start.y, 0.01)]]
	for q in route:
		pts.append([snappedf(q.x, 0.01), snappedf(q.y, 0.01)])
	Bus.walk_changed.emit({"on": true, "guest": "walking", "from": _guest_from, "to": Store.room_label(target_room), "metres": snappedf(metres, 0.1), "route": pts})
	var go := func():
		if walker and not _live and _guest_target != Vector2.INF and not walker.go_to(_guest_target):
			_guest_skip()
	if walker.lift_busy():
		walker.stepped_out.connect(func(): go.call(), CONNECT_ONE_SHOT)  # set off once out of the lift
	else:
		get_tree().create_timer(Walker.INTRO + 0.3).timeout.connect(go)
	if _live:
		walker.set_live(true)


## Where a guest's walk begins: the entrance the host chose; else just inside a door to the outside;
## else a lift, lobby, reception or stair; else the best-connected room (usually the corridor).
var _arrival_lift := {}  # the lift a guest arrives in (its door item), if the walk starts at a lift lobby


func _guest_entrance(nav: WalkNav, target_room: Dictionary) -> Vector2:
	var chosen: Dictionary = Store.room(str(Store.guest.get("entrance", "")))
	# a lift lobby: the guest steps out of the middle lift
	if not chosen.is_empty():
		var lifts: Array = []
		var cpoly := PlanGeo.room_poly(chosen)
		for f in Store.furniture:
			if f.get("kind", "") == "lift_door" and not f.get("panel", false) and Geometry2D.is_point_in_polygon(Vector2(float(f.x), float(f.z)), cpoly):
				lifts.append(f)
		if not lifts.is_empty():
			lifts.sort_custom(func(a, b): return float(a.x) < float(b.x))
			var lf: Dictionary = lifts[lifts.size() / 2]
			var rot := float(lf.get("rot", 0.0))
			var out := Vector2(float(lf.x), float(lf.z)) + Vector2(sin(rot), cos(rot)) * 0.9
			_arrival_lift = lf
			return nav.nearest_free(out, 8)
	if not chosen.is_empty():
		var p := nav.room_target(chosen, PlanGeo.interior_point(PlanGeo.room_poly(target_room)))
		if p != Vector2.INF:
			return p
	var goal := PlanGeo.interior_point(PlanGeo.room_poly(target_room))
	var best := Vector2.INF
	var best_len := INF
	# Any other floor: where a visitor really comes in. Every door to the outside is a candidate, scored by the
	# room it opens into (a hall, corridor, lobby or living area is how people enter; a bedroom, bathroom, store,
	# kitchen or balcony is not), by how many doors that room has (circulation), and by its width (the main door
	# is the wide one). A start needs a real walk to the room: never the room itself or right beside it.
	var hub_re := RegEx.create_from_string("(?i)hall|corridor|passage|lobby|foyer|entry|entrance|reception|living|lounge|porch|vestibule|waiting")
	var bad_re := RegEx.create_from_string("(?i)bath|toilet|\\bwc\\b|shower|bed|closet|wardrobe|store|storage|balcony|terrace|deck|patio|garage|utility|laundry|kitchen|pantry|plant|server|electrical|a/?c\\b")
	var doors_of := {}
	for f in Store.furniture:
		if f.get("kind", "") != "door":
			continue
		var c0 := Vector2(float(f.x), float(f.z))
		var n0 := Vector2(sin(float(f.get("rot", 0.0))), cos(float(f.get("rot", 0.0))))
		for side in [1.0, -1.0]:
			var r0: Dictionary = Store.room_at(c0 + n0 * side * 0.45)
			if not r0.is_empty():
				doors_of[r0.key] = int(doors_of.get(r0.key, 0)) + 1
	var best_score := -INF
	for f in Store.furniture:
		if f.get("kind", "") != "door":
			continue
		var c := Vector2(float(f.x), float(f.z))
		var rot := float(f.get("rot", 0.0))
		var n := Vector2(sin(rot), cos(rot))
		for side in [1.0, -1.0]:
			var r: Dictionary = Store.room_at(c - n * side * 0.45)
			if not Store.room_at(c + n * side * 0.45).is_empty() or r.is_empty() or r.key == target_room.key:
				continue
			var inside := nav.nearest_free(c - n * side * 0.8, 6)
			var L := nav.path_length(inside, goal)
			if L == INF or L < 3.0:
				continue
			var nm := str(r.name) + " " + str(r.get("label", ""))
			var score := 0.0
			if hub_re.search(nm) != null:
				score += 4.0
			if bad_re.search(nm) != null:
				score -= 4.0
			score += minf(float(doors_of.get(r.key, 0)), 4.0)
			score += clampf((float(f.get("w", 0.9)) - 0.85) * 5.0, 0.0, 2.0)
			score -= 0.02 * L
			if score > best_score:
				best_score = score
				best = inside
	if best != Vector2.INF and best_score > -2.0:
		return best
	# no door to the outside fits: start in the floor's circulation, the hall or corridor with the most doors
	best = Vector2.INF
	best_score = -INF
	for r in Store.rooms:
		if r.key == target_room.key:
			continue
		var nm := str(r.name) + " " + str(r.get("label", ""))
		var score := minf(float(doors_of.get(r.key, 0)), 5.0) + (4.0 if hub_re.search(nm) != null else 0.0) - (4.0 if bad_re.search(nm) != null else 0.0)
		var p := nav.room_target(r, goal)
		if p == Vector2.INF or nav.path_length(p, goal) == INF or nav.path_length(p, goal) < 3.0:
			continue
		if score > best_score:
			best_score = score
			best = p
	if best != Vector2.INF and best_score >= 2.0:
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


var _guest_settled := false   # the guest has arrived in their room (the arrival runs once per walk)


## The guest reached their room: keep them in it, step to where the whole room is in view, say so. Only the first
## time: every later walk inside the room (a tap on the floor) ends here too and must stay where it ended.
func _guest_arrived() -> void:
	if walker == null or _guest_room == "" or walker.room_key != _guest_room or _guest_settled:
		return
	_guest_settled = true
	walker.confine(Store.room(_guest_room))
	# step to where the whole room is in view and turn to take it in
	walker.view_room(Store.room(_guest_room))
	walker.hide_route()
	Bus.walk_changed.emit({"on": true, "guest": "arrived", "room": _guest_room, "roomName": Store.room_label(Store.room(_guest_room))})


## Where to stand on entering a room and which way to look: just inside its door (clear of the furniture),
## facing the far side of the room. Without a door: the room's middle, facing its longer side.
func _room_entry(r: Dictionary) -> Array:
	var poly := PlanGeo.room_poly(r)
	var mid := PlanGeo.interior_point(poly)
	var bb := Rect2(poly[0], Vector2.ZERO)
	for v in poly:
		bb = bb.expand(v)
	var centre := bb.get_center()
	if not Geometry2D.is_point_in_polygon(centre, poly):
		centre = mid
	for f in Store.furniture:
		if f.get("kind", "") != "door":
			continue
		var c := Vector2(float(f.x), float(f.z))
		var nn := Vector2(sin(float(f.get("rot", 0.0))), cos(float(f.get("rot", 0.0))))
		for side in [1.0, -1.0]:
			var inside: Vector2 = c + nn * side * 1.35
			if Geometry2D.is_point_in_polygon(inside, poly) and not Geometry2D.is_point_in_polygon(c - nn * side * 0.85, poly):
				# look across the room to its far side
				var far := centre + (centre - c).normalized() * 0.6 * minf(bb.size.x, bb.size.y)
				var d := far - inside
				return [inside, atan2(-d.x, -d.y)]
	var d2 := Vector2(1, 0) if bb.size.x >= bb.size.y else Vector2(0, 1)
	return [mid, atan2(-d2.x, -d2.y)]


## A live position fix (RTLS badge, location QR code or step tracking): snap it to walkable floor (map
## matching), walk the guest's view there through doorways, re-plan the way to the room from it, and count it
## as arriving once the fix is inside the room.
func _live_fix() -> void:
	if walker == null or Store.me.is_empty():
		return
	var at := float(Store.me.get("at", 0.0))
	if at == _last_fix:
		return
	_last_fix = at
	var acc := float(Store.me.get("accuracy", 2.0))
	var raw := Vector2(float(Store.me.x), float(Store.me.z))
	# a fresh start (first fix, or a location code) is taken as given; otherwise matched to where we were
	var fresh := _fix_count == 0 or str(Store.me.get("source", "")) == "checkpoint"
	var q := walker.nav.match_fix(raw, walker.p, acc, not fresh)
	_fix_count += 1
	walker.live_fix(q, acc, str(Store.me.get("source", "")))
	var info := {"on": true, "live": {"x": snappedf(q.x, 0.01), "z": snappedf(q.y, 0.01), "room": Store.room_label(Store.room_at(q))}}
	if _guest_target != Vector2.INF:
		var left := walker.nav.path_length(q, _guest_target)
		var in_room: bool = not Store.room_at(q).is_empty() and Store.room_at(q).key == _guest_room
		info.live["toRoom"] = 0.0 if in_room else snappedf(left, 0.1)
		info.live["atDoor"] = not in_room and left < 3.0
		if Time.get_ticks_msec() - _route_at > 3000 and not in_room:
			_route_at = Time.get_ticks_msec()
			walker.show_route(q, walker.nav.path(q, _guest_target), Store.room_label(Store.room(_guest_room)))
		elif in_room:
			walker.hide_route()
	Bus.walk_changed.emit(info)
	var r: Dictionary = Store.room_at(q)
	if not r.is_empty() and r.key == _guest_room:
		walker._track_room()
		# arrived by their own steps: say so once (the room is not locked in, the position may still move on)
		if not _live_arrived:
			_live_arrived = true
			walker.hide_route()
			Bus.walk_changed.emit({"on": true, "guest": "arrived", "room": _guest_room, "roomName": Store.room_label(Store.room(_guest_room))})
	else:
		_live_arrived = false


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
	walker.finish_lift()   # skipped while the lift was still arriving
	walker.teleport(_guest_target)
	walker._track_room()
	_guest_arrived()


## Guided tour stop: the device must be in sight before its control appears on it. If it can't be seen well from
## here (a wall or a tall cupboard in the way, too close under it, too far), walk to the nearest open spot in the
## room that sees it from a comfortable distance, turn to it, and only then tell the host ({viewing: id}).
const _TALL := ["cabinet", "shelf", "rack", "locker", "column", "workstation", "lift_shaft", "vending", "partition", "wardrobe", "bookcase", "fridge"]
var _show_seq := 0

func _show_device(id: String) -> void:
	_show_seq += 1
	var seq := _show_seq
	var dev: Node3D = devices[id]
	var at3 := dev.global_position
	var t := Vector2(at3.x, at3.z)
	var here := walker.p
	# the room the device is in (walking there first when it's elsewhere), else the guest's room
	var r: Dictionary = Store.room(str(Store.device(id).get("room", ""))) if not Store.device(id).is_empty() else {}
	if r.is_empty():
		r = Store.room(_guest_room) if _guest_room != "" else Store.room_at(here)
	var done := func():
		if seq != _show_seq or walker == null:
			return
		walker.look_at_point(at3)
		_mark([id])   # not _on_highlight: that focuses, which comes back here
		Bus.walk_changed.emit({"on": true, "viewing": id})
	var near := _obstacles(t)
	if _sees(here, t, at3.y, near):
		done.call()
		return
	var poly := PlanGeo.room_poly(r) if not r.is_empty() else PackedVector2Array()
	var best := Vector2.INF
	var best_s := INF
	if not poly.is_empty():
		var lo := Vector2(INF, INF)
		var hi := Vector2(-INF, -INF)
		for q in poly:
			lo = Vector2(minf(lo.x, q.x), minf(lo.y, q.y))
			hi = Vector2(maxf(hi.x, q.x), maxf(hi.y, q.y))
		var x := lo.x + 0.3
		while x < hi.x:
			var z := lo.y + 0.3
			while z < hi.y:
				var q := Vector2(x, z)
				z += 0.25
				if not Geometry2D.is_point_in_polygon(q, poly) or q.distance_to(t) > 4.5 or not walker.nav.is_free(q) or not _sees(q, t, at3.y, near):
					continue
				# nearest to where the guest stands, at a comfortable distance from the device
				var s := q.distance_to(here) + absf(q.distance_to(t) - 2.4) * 1.5
				if s < best_s:
					best_s = s
					best = q
			x += 0.25
	if best == Vector2.INF or not walker.go_to(best):
		done.call()
		return
	walker.arrived.connect(func(): done.call(), CONNECT_ONE_SHOT)


## Whether a device at t (height y) is in plain view from q: a comfortable distance (not straight overhead, not
## across the floor), no wall between, and no tall furniture standing in the line of sight.
func _sees(q: Vector2, t: Vector2, y: float, near := []) -> bool:
	var d := q.distance_to(t)
	if d < (1.3 if y > 1.9 else 1.0) or d > 4.5:
		return false
	var a := q
	var b := t.lerp(q, 0.25 / maxf(d, 0.01))   # stop just short of the device (it sits on its wall)
	var obs: Array = near if not near.is_empty() else _obstacles(t)
	for wp in obs[0]:
		if Geometry2D.segment_intersects_segment(a, b, wp[0], wp[1]) != null:
			return false
	for rect in obs[1]:
		for k in range(1, 12):
			if Geometry2D.is_point_in_polygon(a.lerp(b, k / 12.0), rect):
				return false
	return true


## The walls and tall furniture within sight range of t (5 m), prepared once for a tour stop's many checks.
func _obstacles(t: Vector2) -> Array:
	var walls: Array = []
	var rects: Array = []
	if floor_builder:
		for wp in floor_builder.wall_pieces:
			var p0: Vector2 = wp[0]
			var p1: Vector2 = wp[1]
			if Geometry2D.get_closest_point_to_segment(t, p0, p1).distance_to(t) < 5.0:
				walls.append(wp)
	for f in Store.furniture:
		if not _TALL.has(str(f.get("kind", ""))):
			continue
		var c := Vector2(float(f.x), float(f.z))
		if c.distance_to(t) < 6.0:
			rects.append(Placer._rect(c, Vector2(float(f.w), float(f.d)), float(f.get("rot", 0.0))))
	return [walls, rects]



## Smart locks at doors: a locked door's leaf is drawn shut across the opening and walking routes go round it.
## Only rebuilt when a lock actually changes.
func _apply_locks(refresh := true) -> void:
	var sig := ""
	for f in Store.furniture:
		if f.get("kind", "") == "door":
			# the door to the room the walker holds the key for opens for them
			var lk := Store.door_locked(f) and not WalkNav._opens_into(f, Store.key_room)
			if lk != bool(f.get("locked", false)):
				if lk:
					f["locked"] = true
				else:
					f.erase("locked")
			if lk:
				sig += "%.1f,%.1f;" % [float(f.x), float(f.z)]
	if sig == _locks_sig:
		return
	_locks_sig = sig
	if not refresh:
		return
	if walker:
		walker.rebuild_nav()   # routes see the change at once
		return
	if interior and is_instance_valid(interior):
		interior.queue_free()
		interior = Interior.new()
		interior.name = "Interior"
		world.add_child(interior)
		interior.build(Store.furniture if Store.guest_allowed.is_empty() else Store.furniture.filter(func(f):
			if f.get("kind", "") == "door":
				return Store.door_open(f)
			var r: Dictionary = Store.room_at(Vector2(float(f.x), float(f.z)))
			return r.is_empty() or Store.room_allowed(r.key)))



# ---- daylight: the light of the time of day (the viewer's local clock, or an hour the host sets) --------------

var _day_hour := -1.0   # -1: the real time

## 0 at night, rising from dawn (6:00) to 1 at noon and back to 0 at dusk (18:00).
func _daylight() -> float:
	var h := _day_hour
	if h < 0:
		var t := Time.get_datetime_dict_from_system()
		h = float(t.hour) + float(t.minute) / 60.0
	return clampf(sin(PI * (h - 6.0) / 12.0), 0.0, 1.0) if h > 6.0 and h < 18.0 else 0.0


func _apply_daylight() -> void:
	if env == null or sun == null or _night_on:
		return
	var k := _daylight()
	var h := _day_hour
	if h < 0:
		var t := Time.get_datetime_dict_from_system()
		h = float(t.hour) + float(t.minute) / 60.0
	var low := clampf(1.0 - k * 2.5, 0.0, 1.0) * float(k > 0.0)   # warm light near dawn and dusk
	# the sun crosses from the east (morning) to the west (evening), higher at noon
	sun.rotation = Vector3(SUN_TILT - 0.9 * k, deg_to_rad(lerpf(-110.0, 40.0, clampf((h - 6.0) / 12.0, 0.0, 1.0))), 0)
	sun.light_color = Color(1, 0.98, 0.95).lerp(Color(1.0, 0.72, 0.45), low)
	var tw := create_tween().set_parallel(true)
	tw.tween_property(env, "background_color", Color("0b0e12").lerp(Color("1b2430"), k), 2.0)
	tw.tween_property(env, "ambient_light_color", Color("8e9bb8").lerp(Color("aab4c3"), k).lerp(Color("c8a888"), low * 0.4), 2.0)
	if walker:
		tw.tween_property(sun, "light_energy", 0.25 * (0.3 + 0.7 * k), 2.0)
	else:
		tw.tween_property(sun, "light_energy", SUN * (0.4 + 0.6 * k), 2.0)
		tw.tween_property(env, "ambient_light_energy", 0.45 + 0.1 * k, 2.0)
	_room_light()
