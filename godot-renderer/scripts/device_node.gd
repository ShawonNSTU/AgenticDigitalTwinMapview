class_name DeviceNode
extends Node3D
## One SmartThings device on the floor: a simple body, a health ring, a label and a click area.
## Detailed internals are built by DetailView when the device is opened.

const BODY := {
	"ac": Vector3(0.9, 0.28, 0.22), "odu": Vector3(0.9, 0.7, 0.35), "tv": Vector3(1.2, 0.7, 0.06),
	"fridge": Vector3(0.7, 1.8, 0.7), "oven": Vector3(0.6, 0.6, 0.6), "washer": Vector3(0.6, 0.85, 0.6),
	"dryer": Vector3(0.6, 0.85, 0.6), "purifier": Vector3(0.3, 0.6, 0.3), "vacuum": Vector3(0.35, 0.1, 0.35),
	"speaker": Vector3(0.15, 0.25, 0.15), "blinds": Vector3(1.0, 0.08, 0.06), "lock": Vector3(0.08, 0.15, 0.05),
	"camera": Vector3(0.12, 0.12, 0.18), "doorbell": Vector3(0.06, 0.14, 0.03), "light": Vector3(0.22, 0.06, 0.22),
	"plug": Vector3(0.08, 0.08, 0.05), "motion": Vector3(0.08, 0.08, 0.08), "leak": Vector3(0.1, 0.03, 0.1),
	"temphum": Vector3(0.08, 0.08, 0.03),
}

var data: Dictionary
var body: MeshInstance3D
var body_mat := StandardMaterial3D.new()
var ring_mat := StandardMaterial3D.new()
var ring: MeshInstance3D
var label: Label3D
var beam: MeshInstance3D
var _pulse: Tween
var _highlighted := false


func setup(d: Dictionary) -> DeviceNode:
	data = d
	name = d.id
	position = Vector3(d.position[0], d.position[1], d.position[2])
	rotation.y = d.get("rotationY", 0.0)
	var size: Vector3 = BODY.get(d.type, Vector3(0.2, 0.2, 0.2))

	body = MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	body.mesh = bm
	body_mat.albedo_color = Color("eef0f3") if d.type != "tv" else Color("22262c")
	body_mat.roughness = 0.45
	body.material_override = body_mat
	add_child(body)

	ring = MeshInstance3D.new()
	var tm := TorusMesh.new()
	var r := maxf(size.x, size.z) * 0.6 + 0.12
	tm.inner_radius = r
	tm.outer_radius = r + 0.05
	ring.mesh = tm
	ring_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	ring_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	ring.material_override = ring_mat
	ring.position.y = -size.y / 2 - 0.02
	add_child(ring)

	label = Label3D.new()
	label.text = d.id
	label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	label.no_depth_test = true
	label.fixed_size = true
	label.font_size = 24
	label.pixel_size = 0.0006
	label.outline_size = 10
	label.position.y = size.y / 2 + 0.22
	add_child(label)

	beam = MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = 0.05
	cm.bottom_radius = 0.05
	cm.height = 3.0
	beam.mesh = cm
	var beam_mat := StandardMaterial3D.new()
	beam_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	beam_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	beam_mat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	beam_mat.albedo_color = Color(0.3, 0.55, 1.0, 0.5)
	beam.material_override = beam_mat
	beam.position.y = 1.5
	beam.visible = false
	add_child(beam)

	var area := Area3D.new()
	var shape := CollisionShape3D.new()
	var bs := BoxShape3D.new()
	bs.size = size + Vector3(0.25, 0.25, 0.25)
	shape.shape = bs
	area.add_child(shape)
	area.input_ray_pickable = true
	area.input_event.connect(_on_input)
	add_child(area)

	set_health(Store.health.get(d.id, "ok"))
	return self


func set_health(h: String) -> void:
	var c := Store.color_for(h)
	ring_mat.albedo_color = Color(c, 0.9 if h != "ok" else 0.45)
	label.modulate = c.lightened(0.3) if h != "ok" else Color.WHITE
	label.text = data.id if h == "ok" else "%s  ●" % data.id


func set_highlight(on: bool, dim_others: bool) -> void:
	_highlighted = on
	beam.visible = on
	if _pulse:
		_pulse.kill()
	ring.scale = Vector3.ONE
	if on:
		_pulse = create_tween().set_loops()
		_pulse.tween_property(ring, "scale", Vector3(1.35, 1, 1.35), 0.6)
		_pulse.tween_property(ring, "scale", Vector3.ONE, 0.6)
	var a := 1.0 if on or not dim_others else 0.25
	body_mat.transparency = BaseMaterial3D.TRANSPARENCY_DISABLED if a >= 1.0 else BaseMaterial3D.TRANSPARENCY_ALPHA
	body_mat.albedo_color.a = a
	label.visible = a >= 1.0 and _labels_on


var _labels_on := true


func show_label(on: bool) -> void:
	_labels_on = on
	label.visible = on


func set_ghost(on: bool, ghost_mat: Material) -> void:
	body.material_override = ghost_mat if on else body_mat
	ring.visible = not on
	label.visible = not on and _labels_on


func _on_input(_cam: Node, e: InputEvent, _pos: Vector3, _n: Vector3, _i: int) -> void:
	if e is InputEventMouseButton and e.button_index == MOUSE_BUTTON_LEFT and e.pressed and e.double_click:
		Bus.open_requested.emit(data.id, "")
		Bus.device_clicked.emit(data.id)
	elif e is InputEventMouseButton and e.button_index == MOUSE_BUTTON_LEFT and not e.pressed and CameraRig.drag_px < 6.0:
		Bus.device_clicked.emit(data.id)
		Bus.focus_requested.emit(data.id)
