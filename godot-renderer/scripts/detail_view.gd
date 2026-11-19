class_name DetailView
extends Node3D
## Opens a device in place: the body turns into an x-ray shell and its internal parts spread out
## around it on leader lines, each with a live value and health colour from GET /api/devices/:id.

signal part_selected(pos: Vector3)

const PART_SIZE := 0.16
var device: DeviceNode
var _parts := {}   # key -> {node, mat, label}
var _lines: MeshInstance3D
var _ghost := ShaderMaterial.new()
var _focus := ""


func _ready() -> void:
	_ghost.shader = preload("res://shaders/ghost.gdshader")
	Bus.device_data.connect(_on_data)


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


func close() -> void:
	if device:
		device.set_ghost(false, null)
	device = null
	_focus = ""
	for c in get_children():
		c.queue_free()
	_parts.clear()


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
		if not _parts.has(p.key):
			continue
		var e: Dictionary = _parts[p.key]
		var c := Store.color_for(p.health)
		e.mat.albedo_color = c
		e.mat.emission = c * (0.9 if p.health != "ok" else 0.25)
		e.label.text = "%s\n%s" % [e.name, p.value]
		e.label.modulate = c.lightened(0.4) if p.health != "ok" else Color.WHITE
