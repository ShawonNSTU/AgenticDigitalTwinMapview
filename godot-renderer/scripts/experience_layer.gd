class_name ExperienceLayer
extends Node3D
## The hotel experience on the floor, from the platform's live experience data (Store.experience, refreshed with
## every /api/floor poll):
##   comfort   a field over each room's floor: cooler / warmer than the occupant's target, cleaner air, the air moving
##             out of the AC and the purifier (shaders/comfort_field.gdshader), and the room's score above it
##   energy    power flowing from the floor's distribution board to every room along cable trays (dash speed and
##             thickness by the room's watts), a light pillar on every device as tall as its draw, rooms in eco
##   ops       staff: a beacon over every device that needs attention or is predicted to fail (with when), a
##             technician's route from the lift lobby to a device (with the technician walking it)
##   arrival   staff: rooms being prepared for a guest glow amber, ready rooms green, occupied rooms blue
## Nothing here changes the platform; it only shows what the platform reports.

signal tech_arrived(id: String)

const FIELD := preload("res://shaders/comfort_field.gdshader")
const KIND := {"cool": 0.0, "warm": 1.0, "clean": 2.0, "daylight": 3.0, "light": 4.0, "noise": 5.0}

var main   # scripts/main.gd (devices, floor_builder, rig)
var comfort_on := false
var energy_on := false
var ops_on := true

var _comfort := {}     # room -> {mesh, mat, label}
var _energy: Node3D
var _flows := {}       # room -> {mats, label}
var _pillars := {}     # device id -> MeshInstance3D
var _beacons := {}     # device id -> {node, label, kind}
var _auras := {}       # room -> {node, mats, label, state}
var _route: Node3D
var _route_id := ""
var _walker: Node3D
var _walk_pts: PackedVector3Array = PackedVector3Array()
var _walk_s := 0.0
var _walk_len := 0.0
var _reveal := 0.0
var _t := 0.0
var _drawn_dispatch := {}


func setup(m) -> void:
	main = m
	name = "Experience"
	refresh()


func _staff() -> bool:
	return Store.guest_token == ""


func _devices() -> Dictionary:
	return main.devices if main else {}


func _xp(key: String, fallback):
	var v = Store.experience.get(key, fallback)
	return v if typeof(v) == typeof(fallback) else fallback


# ---------------------------------------------------------------- layers on/off

func set_comfort(on: bool) -> void:
	comfort_on = on
	_reveal = 0.0
	if not on:
		for k in _comfort:
			_comfort[k].mesh.queue_free()
			if _comfort[k].label:
				_comfort[k].label.queue_free()
		_comfort.clear()
	refresh()


func set_energy(on: bool) -> void:
	energy_on = on
	if not on and _energy:
		_energy.queue_free()
		_energy = null
		_flows.clear()
		_pillars.clear()
	refresh()


func set_ops(on: bool) -> void:
	ops_on = on
	if not on:
		for id in _beacons.keys():
			_drop_beacon(id)
		for r in _auras.keys():
			_auras[r].node.queue_free()
		_auras.clear()
	refresh()


## New data from the platform (about once a second).
func refresh() -> void:
	if comfort_on:
		_refresh_comfort()
	if energy_on:
		_refresh_energy()
	if ops_on and _staff():
		_refresh_beacons()
		_refresh_auras()
		_refresh_dispatches()


# ---------------------------------------------------------------- comfort

func _refresh_comfort() -> void:
	var data: Dictionary = _xp("comfort", {})
	for key in data:
		var c: Dictionary = data[key]
		var r: Dictionary = Store.room(key)
		if r.is_empty():
			continue
		if not _comfort.has(key):
			_comfort[key] = _make_field(r)
		var e: Dictionary = _comfort[key]
		var mat: ShaderMaterial = e.mat
		var srcs: Array = c.get("sources", [])
		var packed := PackedVector4Array()
		packed.resize(8)
		var n := 0
		for s in srcs:
			if n >= 8:
				break
			var k: float = KIND.get(str(s.get("kind", "")), 4.0)
			if k > 2.5:
				continue   # light, daylight and noise don't change the thermal / air field
			packed[n] = Vector4(float(s.x), float(s.z), float(s.strength), k)
			n += 1
		mat.set_shader_parameter("src", packed)
		mat.set_shader_parameter("count", n)
		mat.set_shader_parameter("delta", float(c.get("temp", 23)) - float(c.get("target", 23)))
		mat.set_shader_parameter("air", clampf((float(c.get("pm", 12)) - 8.0) / 40.0, 0.0, 1.0))
		mat.set_shader_parameter("score", float(c.get("score", 100)) / 100.0)
		mat.set_shader_parameter("metric", {"thermal": 0, "air": 1, "score": 2}.get(Store.comfort_metric, 0))
		if e.label:
			var g := str(c.get("grade", ""))
			e.label.text = "%.1f °C   ·   %d" % [float(c.get("temp", 0)), int(c.get("score", 0))]
			e.label.modulate = {"excellent": Color("7ee2a8"), "good": Color("b9e88a"), "fair": Color("ffc266"), "poor": Color("ff8a7a")}.get(g, Color.WHITE)
			e.label.visible = not Store.walk


func _make_field(r: Dictionary) -> Dictionary:
	var poly: PackedVector2Array = PlanGeo.room_poly(r)
	var tris := Geometry2D.triangulate_polygon(poly)
	if tris.is_empty():
		poly = Geometry2D.convex_hull(poly)
		tris = Geometry2D.triangulate_polygon(poly)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	st.set_normal(Vector3.UP)
	for i in tris:
		st.add_vertex(Vector3(poly[i].x, 0.03, poly[i].y))
	var m := MeshInstance3D.new()
	m.mesh = st.commit()
	m.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	var mat := ShaderMaterial.new()
	mat.shader = FIELD
	mat.render_priority = 1
	mat.set_shader_parameter("alpha", 0.3 if Store.walk else 0.62)   # at eye level a light overlay; from above the full field
	m.material_override = mat
	add_child(m)
	var label: Label3D = null
	if not Store.walk:
		label = _tag(PlanGeo.interior_point(poly), Store.wall_height + 0.55, "", Color.WHITE, 26)
	return {"mesh": m, "mat": mat, "label": label}


# ---------------------------------------------------------------- energy

## Where the floor's power comes from: an electrical / utility / plant room, else the outdoor unit's pad, else the
## middle of the floor.
func _board() -> Vector2:
	for r in Store.rooms:
		if str(r.get("name", "")).to_lower().contains("electric") or str(r.get("name", "")).to_lower().contains("utility") or str(r.get("name", "")).to_lower().contains("plant"):
			return PlanGeo.interior_point(PlanGeo.room_poly(r))
	if not Store.outdoor_pad.is_empty():
		return Vector2(float(Store.outdoor_pad.get("x", 0)), float(Store.outdoor_pad.get("z", 0)))
	return Store.floor_rect().get_center()


static func load_colour(w: float) -> Color:
	if w < 30.0:
		return Color("36d399")
	if w < 300.0:
		return Color("fbbf24")
	return Color("f87171")


func _refresh_energy() -> void:
	if _energy == null:
		_energy = Node3D.new()
		_energy.name = "Energy"
		add_child(_energy)
	var watts: Dictionary = _xp("watts", {})
	var eco: Array = _xp("eco", [])
	var per_room := {}
	for d in Store.devices:
		var w := float(watts.get(d.id, 0.0))
		per_room[d.room] = float(per_room.get(d.room, 0.0)) + w
		_pillar(d, w)
	var h := Store.wall_height + 0.22
	var board := _board()
	for key in per_room:
		var r: Dictionary = Store.room(key)
		if r.is_empty():
			continue
		var w: float = per_room[key]
		var c := PlanGeo.interior_point(PlanGeo.room_poly(r))
		if not _flows.has(key):
			var pts := [Vector3(board.x, h, board.y), Vector3(c.x, h, board.y), Vector3(c.x, h, c.y), Vector3(c.x, h - 0.2, c.y)]
			var radius := 0.018
			var mats: Array = Tube.build(_energy, pts, load_colour(w), radius, 0.5)
			var label := _tag(c, h + 0.35, "", Color.WHITE, 22, _energy)
			_flows[key] = {"mats": mats, "label": label}
		var col := load_colour(w)
		for m in _flows[key].mats:
			m.set_shader_parameter("base_color", col)
			m.set_shader_parameter("speed", clampf(log(1.0 + w) / 2.2, 0.05, 3.0) if w > 0.5 else 0.0)
			m.set_shader_parameter("glow", clampf(0.5 + w / 400.0, 0.5, 2.2))
		var l: Label3D = _flows[key].label
		var in_eco := eco.has(key)
		l.text = ("ECO   " if in_eco else "") + ("%d W" % roundi(w) if w < 1000 else "%.2f kW" % (w / 1000.0))
		l.modulate = Color("7ee2a8") if in_eco else col.lightened(0.35)
		l.visible = not Store.walk


## A light pillar standing on a device, as tall as its draw (log scale: 1 W short, 1 kW tall).
func _pillar(d: Dictionary, w: float) -> void:
	var dev: Node3D = _devices().get(d.id)
	if dev == null:
		return
	var m: MeshInstance3D = _pillars.get(d.id)
	if m == null:
		m = MeshInstance3D.new()
		var cm := CylinderMesh.new()
		cm.top_radius = 0.035
		cm.bottom_radius = 0.035
		cm.height = 1.0
		cm.radial_segments = 8
		m.mesh = cm
		var mat := StandardMaterial3D.new()
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		mat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
		m.material_override = mat
		m.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		_energy.add_child(m)
		_pillars[d.id] = m
	var hgt := clampf(log(1.0 + w) / log(10.0) * 0.4, 0.02, 1.4)
	var p := dev.global_position
	m.scale = Vector3(1, hgt, 1)
	m.global_position = Vector3(p.x, p.y + 0.25 + hgt / 2.0, p.z)
	var c := load_colour(w)
	(m.material_override as StandardMaterial3D).albedo_color = Color(c, 0.55 if w > 0.5 else 0.15)
	m.visible = w > 0.3


# ---------------------------------------------------------------- ops: beacons for attention and predictions

func _refresh_beacons() -> void:
	var want := {}
	for d in Store.devices:
		var h: String = Store.health.get(d.id, "ok")
		if h != "ok":
			want[d.id] = {"kind": h, "text": ""}
	for p in _xp("predictions", []):
		var id := str(p.get("id", ""))
		if id == "" or want.has(id):
			continue
		var eta = p.get("etaMin")
		want[id] = {"kind": "predicted", "text": ("fails in %s" % _eta_text(float(eta))) if eta != null else str(p.get("title", ""))}
	for id in _beacons.keys():
		if not want.has(id) or _beacons[id].kind != want[id].kind:
			_drop_beacon(id)
	for id in want:
		if not _beacons.has(id):
			_beacon(id, want[id].kind)
		if _beacons.has(id) and _beacons[id].label:
			_beacons[id].label.text = want[id].text
			_beacons[id].label.visible = want[id].text != "" and not Store.walk


static func _eta_text(m: float) -> String:
	if m < 1.0:
		return "under a minute"
	if m < 90.0:
		return "%d min" % roundi(m)
	if m < 2880.0:
		return "%.1f h" % (m / 60.0)
	return "%d days" % roundi(m / 1440.0)


func _beacon(id: String, kind: String) -> void:
	var dev: Node3D = _devices().get(id)
	if dev == null:
		return
	var col: Color = {"fault": Color("ef4444"), "watch": Color("f59e0b"), "predicted": Color("a78bfa")}.get(kind, Color.WHITE)
	var n := Node3D.new()
	add_child(n)
	var p := dev.global_position
	n.global_position = Vector3(p.x, 0, p.z)
	var beam := MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = 0.02
	cm.bottom_radius = 0.09
	cm.height = 3.2
	cm.radial_segments = 10
	beam.mesh = cm
	var bm := StandardMaterial3D.new()
	bm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	bm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	bm.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	bm.albedo_color = Color(col, 0.45)
	beam.material_override = bm
	beam.position.y = 1.6
	beam.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	n.add_child(beam)
	var ring := MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = 0.32
	tm.outer_radius = 0.4
	ring.mesh = tm
	var rm := bm.duplicate() as StandardMaterial3D
	rm.albedo_color = Color(col, 0.8)
	ring.material_override = rm
	ring.scale = Vector3(1, 0.1, 1)
	ring.position.y = 0.04
	n.add_child(ring)
	var label: Label3D = _tag(Vector2.ZERO, 3.45, "", col.lightened(0.35), 22, n)
	label.position = Vector3(0, 3.45, 0)
	_beacons[id] = {"node": n, "ring": ring, "beam": beam, "label": label, "kind": kind}
	n.visible = not Store.walk


func _drop_beacon(id: String) -> void:
	if _beacons.has(id):
		if is_instance_valid(_beacons[id].node):
			_beacons[id].node.queue_free()
		_beacons.erase(id)


# ---------------------------------------------------------------- arrival auras

func _refresh_auras() -> void:
	var want := {}
	for j in _xp("journeys", []):
		var st := str(j.get("state", ""))
		if st in ["en_route", "preparing", "ready", "arrived"]:
			want[str(j.room)] = j
	for r in _auras.keys():
		if not want.has(r) or _auras[r].state != str(want[r].state):
			_auras[r].node.queue_free()
			_auras.erase(r)
	for r in want:
		var j: Dictionary = want[r]
		if not _auras.has(r):
			_aura(r, str(j.state))
		if _auras.has(r):
			var who := str(j.get("guest", ""))
			var text: String = {"en_route": "on the way", "preparing": "preparing", "ready": "ready", "arrived": "in the room"}.get(str(j.state), "")
			var eta = j.get("eta")
			if eta != null and str(j.state) in ["en_route", "preparing"]:
				var mins := (float(eta) - Time.get_unix_time_from_system() * 1000.0) / 60000.0
				if mins > 0:
					text += " · %d min" % ceili(mins)
			_auras[r].label.text = ("%s · %s" % [who, text]) if who != "" else text
			_auras[r].label.visible = not Store.walk


func _aura(room: String, state: String) -> void:
	var r: Dictionary = Store.room(room)
	if r.is_empty():
		return
	var col: Color = {"en_route": Color("93c5fd"), "preparing": Color("fbbf24"), "ready": Color("34d399"), "arrived": Color("60a5fa")}.get(state, Color.WHITE)
	var n := Node3D.new()
	add_child(n)
	var poly: PackedVector2Array = PlanGeo.room_poly(r)
	var pts: Array = []
	for p in poly:
		pts.append(Vector3(p.x, 0.06, p.y))
	pts.append(pts[0])
	var mats: Array = Tube.build(n, pts, col, 0.03, 0.6)
	for m in mats:
		m.set_shader_parameter("speed", 0.8 if state == "preparing" else 0.25)
		m.set_shader_parameter("glow", 1.6)
	var label := _tag(PlanGeo.interior_point(poly), Store.wall_height + 0.95, "", col.lightened(0.3), 24, n)
	_auras[room] = {"node": n, "mats": mats, "label": label, "state": state}


# ---------------------------------------------------------------- technician route

func _refresh_dispatches() -> void:
	var live := {}
	for x in _xp("dispatches", []):
		var id := str(x.get("id", ""))
		live[id] = true
		if not _drawn_dispatch.has(id) and str(x.get("status", "")) == "en_route":
			_drawn_dispatch[id] = true
			dispatch(id, str(x.get("from", "")))
	for id in _drawn_dispatch.keys():
		if not live.has(id):
			_drawn_dispatch.erase(id)
			if id == _route_id:
				clear_route()


## Draw the way from the entrance (the lift lobby) to the device and walk a technician along it.
func dispatch(id: String, from_key := "") -> void:
	var dev: Node3D = _devices().get(id)
	if dev == null or main.floor_builder == null:
		return
	clear_route()
	_route_id = id
	var start := Vector2.INF
	var from_room: Dictionary = Store.room(from_key)
	if from_room.is_empty():
		for r in Store.rooms:
			var nm := str(r.get("name", "")).to_lower()
			if nm.contains("lift") or nm.contains("lobby") or nm.contains("entrance") or nm.contains("reception"):
				from_room = r
				break
	if not from_room.is_empty():
		start = PlanGeo.interior_point(PlanGeo.room_poly(from_room))
	var p := dev.global_position
	var goal := Vector2(p.x, p.z)
	var nav := WalkNav.new()
	nav.build(main.floor_builder.wall_pieces, main.floor_builder.lintels)
	if start == Vector2.INF:
		start = nav.nearest_free(Store.floor_rect().get_center())
	start = nav.nearest_free(start)
	var near_goal := nav.nearest_free(goal)
	var path: PackedVector2Array = nav.path(start, near_goal)
	var pts := PackedVector2Array([start]) + path
	if pts[pts.size() - 1].distance_to(goal) > 0.3:
		pts.append(goal)
	_route = Node3D.new()
	_route.name = "TechRoute"
	add_child(_route)
	var col := Color("f59e0b")
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.albedo_color = Color(col, 0.9)
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	var chev := PrismMesh.new()
	chev.size = Vector3(0.3, 0.34, 0.01)
	var metres := 0.0
	_walk_pts = PackedVector3Array()
	var carry := 0.0
	for i in pts.size() - 1:
		var a := pts[i]
		var b := pts[i + 1]
		var len := a.distance_to(b)
		metres += len
		var d := (b - a) / maxf(len, 0.001)
		var t := carry
		while t < len:
			var q := a + d * t
			var m := MeshInstance3D.new()
			m.mesh = chev
			m.material_override = mat
			m.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			m.position = Vector3(q.x, 0.03, q.y)
			m.rotation = Vector3(-PI / 2, atan2(-d.x, -d.y), 0)
			_route.add_child(m)
			t += 0.8
		carry = t - len
	for q in pts:
		_walk_pts.append(Vector3(q.x, 0, q.y))
	_walk_len = metres
	_walk_s = 0.0
	var who := "Technician"
	_tag(pts[0], 2.1, "%s · %d m" % [who, roundi(metres)], col.lightened(0.3), 24, _route)
	# the technician: a small figure walking the route
	_walker = Node3D.new()
	_route.add_child(_walker)
	var body := MeshInstance3D.new()
	var cap := CapsuleMesh.new()
	cap.radius = 0.18
	cap.height = 1.1
	body.mesh = cap
	var bm := StandardMaterial3D.new()
	bm.albedo_color = col
	bm.emission_enabled = true
	bm.emission = col * 0.6
	body.material_override = bm
	body.position.y = 0.55
	_walker.add_child(body)
	_walker.position = _walk_pts[0]
	# show the whole way
	var box := AABB(Vector3(pts[0].x, 0, pts[0].y), Vector3.ZERO)
	for q in pts:
		box = box.expand(Vector3(q.x, 0, q.y))
	if not Store.walk:
		main.rig.fly_to(box.get_center(), clampf(box.size.length() * 1.15 + 4.0, 7.0, 40.0))
	Bridge.emit_event({"type": "techRoute", "id": id, "metres": snappedf(metres, 0.1), "from": Store.room_label(from_room) if not from_room.is_empty() else "Entrance", "phase": "started" if path.size() > 0 else "failed"})


func clear_route() -> void:
	if _route and is_instance_valid(_route):
		_route.queue_free()
	_route = null
	_walker = null
	_route_id = ""


# ---------------------------------------------------------------- animation

func _process(delta: float) -> void:
	_t += delta
	if comfort_on and _reveal < 1.0:
		_reveal = minf(1.0, _reveal + delta / 1.4)
		for k in _comfort:
			_comfort[k].mat.set_shader_parameter("reveal", _reveal)
	var k := 1.0 + 0.25 * (0.5 + 0.5 * sin(_t * 4.0))
	for id in _beacons:
		var b: Dictionary = _beacons[id]
		if is_instance_valid(b.ring):
			b.ring.scale = Vector3(k, 0.1, k)
	for r in _auras:
		var a: Dictionary = _auras[r]
		if a.state == "preparing":
			for m in a.mats:
				m.set_shader_parameter("glow", 1.0 + 0.8 * (0.5 + 0.5 * sin(_t * 3.0)))
	if _walker and is_instance_valid(_walker) and _walk_pts.size() > 1 and _walk_s < _walk_len:
		_walk_s = minf(_walk_len, _walk_s + delta * 2.2)   # a brisk walk, sped up for the view
		var s := _walk_s
		for i in _walk_pts.size() - 1:
			var seg := _walk_pts[i].distance_to(_walk_pts[i + 1])
			if s <= seg or i == _walk_pts.size() - 2:
				var a := _walk_pts[i]
				var b := _walk_pts[i + 1]
				_walker.position = a.lerp(b, clampf(s / maxf(seg, 0.001), 0.0, 1.0))
				if (b - a).length() > 0.01:
					_walker.rotation.y = atan2(b.x - a.x, b.z - a.z)
				break
			s -= seg
		if _walk_s >= _walk_len:
			tech_arrived.emit(_route_id)
			Bridge.emit_event({"type": "techRoute", "id": _route_id, "metres": snappedf(_walk_len, 0.1), "from": "", "phase": "arrived"})


# ---------------------------------------------------------------- helpers

func _tag(at: Vector2, y: float, text: String, col: Color, size := 24, parent: Node = null) -> Label3D:
	var l := Label3D.new()
	l.text = text
	l.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	l.fixed_size = true
	l.pixel_size = 0.0007
	l.font_size = size
	l.outline_size = 8
	l.outline_modulate = Color(0.04, 0.06, 0.1, 0.92)
	l.modulate = col
	l.no_depth_test = true
	l.render_priority = 3
	l.position = Vector3(at.x, y, at.y)
	(parent if parent else self).add_child(l)
	return l
