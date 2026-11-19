class_name DetailView
extends Node3D
## Opens a device in place: the body turns into an x-ray shell and its internal parts spread out
## around it on leader lines, each with a live value and health colour from GET /api/devices/:id.

signal part_selected(pos: Vector3)
signal legend_changed(text: String)

const MEDIA_NAMES := {"refrigerant_liquid": "refrigerant (liquid)", "refrigerant_gas": "refrigerant (gas)", "air": "air", "water": "water", "drain": "drain water", "power": "power", "signal": "signal", "heat": "heat", "light": "light"}
static var _flow_defs: Dictionary = {}

const PART_SIZE := 0.16
var device: DeviceNode
var _parts := {}   # key -> {node, mat, label}
var _lines: MeshInstance3D
var _ghost := ShaderMaterial.new()
var _focus := ""
var _flows: Array = []   # {mats, from, to, color}
var _health := {}        # part key -> health from the latest live data


func _ready() -> void:
	_ghost.shader = preload("res://shaders/ghost.gdshader")
	Bus.device_data.connect(_on_data)
	if _flow_defs.is_empty():
		var f := FileAccess.open("res://data/internal_flows.json", FileAccess.READ)
		if f:
			_flow_defs = JSON.parse_string(f.get_as_text())


## yaw: the camera yaw the view will settle at, so the parts fan out facing the viewer.
func open(dev: DeviceNode, yaw: float) -> void:
	close()
	device = dev
	dev.set_ghost(true, _ghost)
	var spec: Dictionary = Store.types.get(dev.data.type, {})
	var parts: Array = spec.get("parts", [])
	var n := parts.size()
	var radius := clampf(0.35 + n * 0.06, 0.6, 1.1)
	var centre := dev.global_position
	var right := Vector3(cos(yaw), 0, -sin(yaw))
	var im := ImmediateMesh.new()
	_lines = MeshInstance3D.new()
	_lines.mesh = im
	var lm := StandardMaterial3D.new()
	lm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	lm.albedo_color = Color(0.6, 0.75, 1.0, 0.6)
	lm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_lines.material_override = lm
	add_child(_lines)
	im.surface_begin(Mesh.PRIMITIVE_LINES)
	for k in n:
		var p: Dictionary = parts[k]
		var a := PI - TAU * k / n  # clockwise from the left
		var pos := centre + right * cos(a) * radius + Vector3.UP * (0.1 + sin(a) * radius * 0.65)
		var node := MeshInstance3D.new()
		if k % 2 == 0:
			var bm := BoxMesh.new()
			bm.size = Vector3.ONE * PART_SIZE
			node.mesh = bm
		else:
			var cm := CylinderMesh.new()
			cm.top_radius = PART_SIZE * 0.5
			cm.bottom_radius = PART_SIZE * 0.5
			cm.height = PART_SIZE
			node.mesh = cm
		var mat := StandardMaterial3D.new()
		mat.albedo_color = Store.color_for("ok")
		mat.emission_enabled = true
		mat.emission = mat.albedo_color * 0.3
		node.material_override = mat
		add_child(node)
		node.global_position = centre
		create_tween().tween_property(node, "global_position", pos, 0.5).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT).set_delay(0.03 * k)
		var label := Label3D.new()
		label.text = p.name + ("\n(inferred)" if p.get("inferred", false) else "")
		label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		label.no_depth_test = true
		label.fixed_size = true
		label.font_size = 26
		label.pixel_size = 0.0006
		label.outline_size = 8
		label.position = Vector3(0, PART_SIZE * 0.75, 0)
		node.add_child(label)
		var area := Area3D.new()
		var cs := CollisionShape3D.new()
		var sh := BoxShape3D.new()
		sh.size = Vector3.ONE * PART_SIZE * 1.8
		cs.shape = sh
		area.add_child(cs)
		var key: String = p.key
		area.input_event.connect(func(_c, e, _p, _n, _i):
			if e is InputEventMouseButton and e.button_index == MOUSE_BUTTON_LEFT and not e.pressed and CameraRig.drag_px < 6.0:
				Bus.part_clicked.emit(device.data.id, key)
				focus_part(key))
		node.add_child(area)
		_parts[key] = {"node": node, "mat": mat, "label": label, "name": p.name, "pos": pos}
		im.surface_add_vertex(centre)
		im.surface_add_vertex(pos)
	im.surface_end()
	# Internal flows appear once the parts have spread out.
	var dev_id: String = dev.data.id
	get_tree().create_timer(0.55 + 0.03 * n).timeout.connect(func():
		if device and device.data.id == dev_id:
			_build_flows(dev.data.type, centre))


func _build_flows(type: String, centre: Vector3) -> void:
	var media: Dictionary = _flow_defs.get("_media", {})
	var used := {}
	for f in _flow_defs.get(type, []):
		var a: Vector3 = centre if f.from == "@body" else _parts.get(f.from, {}).get("pos", centre)
		var b: Vector3 = centre if f.to == "@body" else _parts.get(f.to, {}).get("pos", centre)
		if a.distance_to(b) < 0.01:
			continue
		# Bend each line outward from the device centre so flows don't cross through the shell.
		var mid := (a + b) / 2
		var out := mid - centre
		out.y *= 0.3
		var ctrl := mid + (out.normalized() * 0.18 if out.length() > 0.01 else Vector3.UP * 0.18)
		var color := Color(media.get(f.medium, "#ffffff"))
		var radius := 0.014 if f.medium.begins_with("refrigerant") or f.medium in ["water", "drain", "air"] else 0.007
		var holder := Node3D.new()
		add_child(holder)
		var mats := Tube.build(holder, Tube.arc(a, b, ctrl), color, radius, 0.12)
		_flows.append({"mats": mats, "from": f.from, "to": f.to, "color": color})
		used[f.medium] = true
	var names: Array = []
	for m in used:
		names.append(MEDIA_NAMES.get(m, m))
	legend_changed.emit("Flows: " + ", ".join(names) if names.size() else "")
	_refresh_flows()


## Flow speed follows part health: ok flows, watch slows, fault stops and turns red.
func _refresh_flows() -> void:
	for f in _flows:
		var worst := "ok"
		for k in [f.from, f.to]:
			var h: String = _health.get(k, "ok")
			if h == "fault" or (h == "watch" and worst == "ok"):
				worst = h
		var speed := 0.35 if worst == "ok" else (0.12 if worst == "watch" else 0.0)
		var col: Color = f.color if worst == "ok" else f.color.lerp(Store.color_for(worst), 0.6)
		for m in f.mats:
			m.set_shader_parameter("speed", speed)
			m.set_shader_parameter("base_color", col)


func close() -> void:
	if device:
		device.set_ghost(false, null)
	device = null
	_focus = ""
	for c in get_children():
		c.queue_free()
	_parts.clear()
	_flows.clear()
	_health.clear()
	legend_changed.emit("")


func focus_part(key: String) -> void:
	if not _parts.has(key):
		return
	if _focus != "" and _parts.has(_focus):
		_parts[_focus].node.scale = Vector3.ONE
	_focus = key
	var node: MeshInstance3D = _parts[key].node
	var tw := create_tween()
	tw.tween_property(node, "scale", Vector3.ONE * 1.6, 0.25)
	part_selected.emit(_parts[key].pos)


func _on_data(id: String, data: Dictionary) -> void:
	if device == null or id != device.data.id:
		return
	for p in data.get("parts", []):
		_health[p.key] = p.health
		if not _parts.has(p.key):
			continue
		var e: Dictionary = _parts[p.key]
		var c := Store.color_for(p.health)
		e.mat.albedo_color = c
		e.mat.emission = c * (0.9 if p.health != "ok" else 0.25)
		e.label.text = "%s\n%s" % [e.name, p.value]
		e.label.modulate = c.lightened(0.4) if p.health != "ok" else Color.WHITE
	_refresh_flows()
