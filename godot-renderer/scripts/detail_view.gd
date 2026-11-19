class_name DetailView
extends Node3D
## The opened device as a digital twin, in place on the map.
##
## The device is shown at a readable size (TWIN metres across, same orientation as installed) inside an
## x-ray shell. Every part sits where it is inside the real unit (data/part_layout.json). "Exploded" moves
## each part straight out from the centre along its own direction, so relative positions are kept.
## Internal flows (data/internal_flows.json) run between the parts. Their speed comes from the device's
## live readings, their colour from the medium, and a part in fault stops every flow touching it.

signal part_selected(pos: Vector3, size: float)
signal legend_changed(text: String)

const TWIN := 1.1          # metres across the largest side of the twin
const SPREAD := 2.6        # exploded: part positions spread over SPREAD × TWIN on every axis
const BODY_PORT := Vector3(-0.55, -0.35, -0.45)  # where '@body' flows enter/leave, in body fractions
const MEDIA_NAMES := {"refrigerant_liquid": "refrigerant (liquid)", "refrigerant_gas": "refrigerant (gas)", "air": "air", "water": "water", "drain": "drain water", "power": "power", "signal": "signal", "heat": "heat", "light": "light"}
static var _flow_defs: Dictionary = {}
static var _layout: Dictionary = {}

var device: DeviceNode
var exploded := true
var twin: Node3D           # scaled, rotated like the device
var _body := Vector3.ONE   # body size in metres (local)
var _parts := {}           # key -> {node, mat, label, name, local, out}
var _flows: Array = []     # {mats, from, to, color, rate}
var _flow_root: Node3D
var _health := {}
var _readings := {}
var _focus := ""
var _ghost := ShaderMaterial.new()


func _ready() -> void:
	_ghost.shader = preload("res://shaders/ghost.gdshader")
	Bus.device_data.connect(_on_data)
	if _flow_defs.is_empty():
		_flow_defs = _json("res://data/internal_flows.json")
		_layout = _json("res://data/part_layout.json")


static func _json(path: String) -> Dictionary:
	var f := FileAccess.open(path, FileAccess.READ)
	return JSON.parse_string(f.get_as_text()) if f else {}


func scale_factor() -> float:
	return TWIN / maxf(_body.x, maxf(_body.y, _body.z))


func centre() -> Vector3:
	return twin.global_position if twin else Vector3.ZERO


func open(dev: DeviceNode, explode_now := true) -> void:
	close()
	device = dev
	dev.set_ghost(true, _ghost)
	_body = DeviceNode.BODY.get(dev.data.type, Vector3(0.2, 0.2, 0.2))
	var k := scale_factor()
	twin = Node3D.new()
	add_child(twin)
	# Lift the twin so even the exploded view clears the floor, however low the real device sits.
	var c := dev.global_position
	c.y = maxf(c.y, TWIN * SPREAD * 0.5 + 0.1)
	twin.global_transform = Transform3D(Basis(Vector3.UP, dev.rotation.y).scaled(Vector3.ONE * k), c)
	var shell := MeshInstance3D.new()
	var sm := BoxMesh.new()
	sm.size = _body
	shell.mesh = sm
	shell.material_override = _ghost
	twin.add_child(shell)
	var spec: Dictionary = Store.types.get(dev.data.type, {})
	var lay: Dictionary = _layout.get(dev.data.type, {})
	for p in spec.get("parts", []):
		var l: Array = lay.get(p.key, [0, 0, 0, 0.2, 0.2, 0.2, "b"])
		var local := Vector3(l[0], l[1], l[2]) * _body
		var size := Vector3(l[3], l[4], l[5]) * _body
		# Exploded position: the same fractional position, but spread evenly on every axis (a flat AC
		# spreads as much in height and depth as in width), so parts keep their order and separate.
		var spread := Vector3(l[0], l[1], l[2]) * (TWIN * SPREAD / k)
		_parts[p.key] = _make_part(p, local, size, l, spread - local)
	_flow_root = Node3D.new()
	add_child(_flow_root)
	exploded = false
	_build_flows()
	if explode_now:
		get_tree().create_timer(0.9).timeout.connect(func():
			if device == dev:
				set_exploded(true))


func _make_part(p: Dictionary, local: Vector3, size: Vector3, l: Array, out: Vector3) -> Dictionary:
	var kind: String = str(l[7]) if l.size() > 7 else "box"
	var node := TwinPart.new()
	twin.add_child(node)
	node.setup(kind, size)
	node.position = local
	var label := Label3D.new()
	label.text = p.name + ("\n(inferred)" if p.get("inferred", false) else "")
	label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	label.no_depth_test = true
	label.fixed_size = true
	label.font_size = 24
	label.pixel_size = 0.0006 / scale_factor()  # labels sit in the scaled twin; keep one on-screen size for every device
	label.outline_size = 8
	label.visible = false  # labels show once exploded, to avoid a pile-up inside the shell
	twin.add_child(label)
	label.position = local + Vector3(0, size.y * 0.5, 0)
	var area := Area3D.new()
	var cs := CollisionShape3D.new()
	var sh := BoxShape3D.new()
	sh.size = size.max(Vector3.ONE * 0.02 * _body.length())
	cs.shape = sh
	area.add_child(cs)
	var key: String = p.key
	area.input_event.connect(func(_c, e, _p, _n, _i):
		if e is InputEventMouseButton and e.button_index == MOUSE_BUTTON_LEFT and not e.pressed and CameraRig.drag_px < 6.0:
			Bus.part_clicked.emit(device.data.id, key)
			focus_part(key))
	node.add_child(area)
	var drives: Array = l[8] if l.size() > 8 else []
	# Exploded parts are enlarged to at least ~0.28 m so small components stay readable.
	var world := maxf(size.x, maxf(size.y, size.z)) * scale_factor()
	var zoom := clampf(0.28 / maxf(world, 0.001), 1.0, 3.0)
	return {"node": node, "label": label, "name": p.name, "local": local, "out": out, "size": size * zoom, "zoom": zoom, "lab": _label_offset(local + out, size * zoom), "drives": drives}


## Animation params for one part from the device's readings (see data/part_layout.json _doc).
static func drive_params(drives: Array, readings: Dictionary) -> Dictionary:
	var out := {}
	for d in drives:
		if not readings.has(d[1]) or readings[d[1]] == null:
			continue
		var v = readings[d[1]]
		var val := 0.0
		if d[2] is String and str(d[2]).begins_with("="):
			val = float(d[3]) if str(v) == str(d[2]).substr(1) else 0.0
		else:
			var num := 0.0
			if typeof(v) == TYPE_BOOL:
				num = 1.0 if v else 0.0
			elif typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT:
				num = float(v)
			elif str(v).is_valid_float():
				num = float(str(v))
			else:
				continue
			val = num * float(d[2]) + float(d[3])
		out[d[0]] = maxf(out.get(d[0], -INF), val)
	return out


## Labels sit on the outside of each part (away from the twin centre), not on top of neighbours.
func _label_offset(at: Vector3, size: Vector3) -> Vector3:
	var dir := at.normalized() if at.length() > 0.001 else Vector3.UP
	return dir * (size.length() * 0.5 + 0.08 / scale_factor()) + Vector3(0, size.y * 0.5, 0)


func set_exploded(on: bool) -> void:
	if twin == null or on == exploded:
		return
	exploded = on
	for f in _flow_root.get_children():
		f.queue_free()
	_flows.clear()
	var tw := create_tween().set_parallel().set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN_OUT)
	for k in _parts:
		var e: Dictionary = _parts[k]
		var to: Vector3 = e.local + (e.out if on else Vector3.ZERO)
		tw.tween_property(e.node, "position", to, 0.6)
		tw.tween_property(e.node, "scale", Vector3.ONE * (e.zoom if on else 1.0), 0.6)
		tw.tween_property(e.label, "position", to + (e.lab if on else Vector3(0, e.size.y * 0.5, 0)), 0.6)
		e.label.visible = on
	tw.chain().tween_callback(_build_flows)


func close() -> void:
	if device:
		device.set_ghost(false, null)
	device = null
	_focus = ""
	for c in get_children():
		c.queue_free()
	twin = null
	_flow_root = null
	_parts.clear()
	_flows.clear()
	_health.clear()
	_readings.clear()
	legend_changed.emit("")


func _port() -> Vector3:
	return twin.to_global(BODY_PORT * _body)


func _part_pos(key: String) -> Vector3:
	return _port() if key == "@body" else twin.to_global(_parts[key].node.position)


func _build_flows() -> void:
	if twin == null:
		return
	var media: Dictionary = _flow_defs.get("_media", {})
	var used := {}
	var c := centre()
	var k := scale_factor()
	for f in _flow_defs.get(device.data.type, []):
		if (f.from != "@body" and not _parts.has(f.from)) or (f.to != "@body" and not _parts.has(f.to)):
			continue
		var a := _part_pos(f.from)
		var b := _part_pos(f.to)
		if a.distance_to(b) < 0.01:
			continue
		# Bend outward from the twin centre so lines don't cut through other parts.
		var mid := (a + b) / 2
		var bend := (mid - c)
		var amount := (0.12 if exploded else 0.04) * minf(1.0, a.distance_to(b) * 2.0)
		var ctrl := mid + (bend.normalized() * amount if bend.length() > 0.01 else Vector3.UP * amount)
		var color := Color(media.get(f.medium, "#ffffff"))
		var thick: bool = f.medium.begins_with("refrigerant") or f.medium in ["water", "drain", "air", "heat"]
		var radius := (0.014 if thick else 0.007) * (1.0 if exploded else 0.7)
		var holder := Node3D.new()
		_flow_root.add_child(holder)
		var mats := Tube.build(holder, Tube.arc(a, b, ctrl), color, radius, 0.1)
		_flows.append({"mats": mats, "from": f.from, "to": f.to, "color": color, "rate": f.get("rate", {})})
		used[f.medium] = true
	var names: Array = []
	for m in used:
		names.append(MEDIA_NAMES.get(m, m))
	legend_changed.emit(("Internal flows (speed = live reading): " + ", ".join(names)) if names.size() else "")
	_refresh_flows()


## 0..1.5 from the flow's rate rule and the latest readings; 1 when there is no rule or no data yet.
func _rate(rule: Dictionary) -> float:
	if rule.is_empty() or not _readings.has(rule.reading):
		return 1.0
	var v = _readings[rule.reading]
	if rule.has("equals"):
		return 1.0 if str(v) == str(rule.equals) else 0.0
	if typeof(v) == TYPE_BOOL:
		return 1.0 if v else 0.0
	if rule.has("max"):
		return clampf(float(v) / float(rule.max), 0.0, 1.5)
	return 1.0


func _refresh_flows() -> void:
	for f in _flows:
		var worst := "ok"
		for key in [f.from, f.to]:
			var h: String = _health.get(key, "ok")
			if h == "fault" or (h == "watch" and worst == "ok"):
				worst = h
		var speed := 0.0 if worst == "fault" else 0.35 * _rate(f.rate)
		var col: Color = f.color if worst == "ok" else f.color.lerp(Store.color_for(worst), 0.6)
		for m in f.mats:
			m.set_shader_parameter("speed", speed)
			m.set_shader_parameter("base_color", col)
			m.set_shader_parameter("glow", 1.0 if speed > 0.001 else 0.45)


func focus_part(key: String) -> void:
	if not _parts.has(key):
		return
	if _focus != "" and _parts.has(_focus):
		_parts[_focus].node.scale = Vector3.ONE * (_parts[_focus].zoom if exploded else 1.0)
	_focus = key
	var e: Dictionary = _parts[key]
	if not exploded:
		set_exploded(true)
	create_tween().tween_property(e.node, "scale", Vector3.ONE * e.zoom * 1.25, 0.25)
	await get_tree().create_timer(0.65).timeout
	if twin and _parts.has(key):
		part_selected.emit(twin.to_global(e.node.position), maxf(e.size.length() * scale_factor(), 0.25))


func _on_data(id: String, data: Dictionary) -> void:
	if device == null or id != device.data.id:
		return
	_readings = data.get("readings", {})
	for p in data.get("parts", []):
		_health[p.key] = p.health
		if not _parts.has(p.key):
			continue
		var e: Dictionary = _parts[p.key]
		(e.node as TwinPart).apply(drive_params(e.drives, _readings), p.health, str(p.value))
		var c := Store.color_for(p.health)
		e.label.text = "%s\n%s" % [e.name, p.value]
		e.label.modulate = c.lightened(0.4) if p.health != "ok" else Color.WHITE
	_refresh_flows()
