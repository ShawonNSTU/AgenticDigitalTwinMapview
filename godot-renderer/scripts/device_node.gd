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
	"temphum": Vector3(0.08, 0.08, 0.03), "fan": Vector3(0.42, 1.1, 0.3),
}
const FX := ["light", "ac", "tv", "blinds", "fan", "purifier", "vacuum", "lock", "plug"]

var data: Dictionary
var fx: DeviceFx  # what the device is doing, shown in the room (light, airflow, screen, blinds...)
var body: MeshInstance3D
var body_mat := StandardMaterial3D.new()
var ring_mat := StandardMaterial3D.new()
var ring: MeshInstance3D
var label: Label3D
var beam: MeshInstance3D
var _pulse: Tween
var _highlighted := false
var _health := "ok"
## On busy floors (many devices) only devices that need attention or are highlighted show their ID.
static var dense := false


func setup(d: Dictionary) -> DeviceNode:
	data = d
	name = d.id
	# height follows the type and the map's cut-away walls (see Placer.mount_y), whatever height the platform stored
	position = Vector3(d.position[0], Placer.mount_y(d.type) if Placer.ALL.has(d.type) else float(d.position[1]), d.position[2])
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

	_details(d.type, size)
	if FX.has(d.type):
		fx = DeviceFx.new().setup(self, d.type, size)
		add_child(fx)

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
	label.no_depth_test = not Store.walk  # walking: walls hide the labels of devices in other rooms
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


## Live state from the platform (Store.live): the room shows what the device is doing.
func apply_live(l: Dictionary) -> void:
	if fx:
		fx.apply(l)


func set_health(h: String) -> void:
	_health = h
	var c := Store.color_for(h)
	ring_mat.albedo_color = Color(c, 0.9 if h != "ok" else 0.45)
	label.modulate = c.lightened(0.3) if h != "ok" else Color.WHITE
	label.text = data.id if h == "ok" else "%s  ●" % data.id
	_ring_visible()
	_update_label()


func _ring_visible() -> void:
	# walking: the status ring only shows on devices that need attention (it reads as clutter in a room)
	ring.visible = not Store.walk or _health != "ok" or _highlighted


func _update_label() -> void:
	label.visible = _labels_on and body.visible and (not dense or _health != "ok" or _highlighted)


func set_highlight(on: bool, dim_others: bool) -> void:
	_highlighted = on
	beam.visible = on and not Store.walk
	_ring_visible()
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
	_update_label()
	if a < 1.0:
		label.visible = false


var _labels_on := true


func show_label(on: bool) -> void:
	_labels_on = on
	_update_label()


## While the twin is open the real-size body hides; the twin shows the device instead.
func set_ghost(on: bool, _ghost_mat: Material) -> void:
	body.visible = not on
	ring.visible = not on
	_update_label()


func _on_input(_cam: Node, e: InputEvent, _pos: Vector3, _n: Vector3, _i: int) -> void:
	if e is InputEventMouseButton and e.button_index == MOUSE_BUTTON_LEFT and e.pressed and e.double_click:
		Bus.open_requested.emit(data.id, "")
		Bus.device_clicked.emit(data.id)
	elif e is InputEventMouseButton and e.button_index == MOUSE_BUTTON_LEFT and not e.pressed and CameraRig.drag_px < 6.0:
		Bus.device_clicked.emit(data.id)
		Bus.focus_requested.emit(data.id)



## Recognisable exterior per type (front faces +z).
func _details(type: String, s: Vector3) -> void:
	var dark := _m(Color("2a2d33"), 0.2, 0.5)
	var metal := _m(Color("b7bcc2"), 0.8, 0.3)
	match type:
		"ac":
			for i in 6:
				_add_box(Vector3(s.x * 0.86, s.y * 0.025, s.z * 0.02), Vector3(0, -s.y * 0.15 - i * s.y * 0.05, s.z * 0.5), dark)
			_add_box(Vector3(s.x * 0.8, s.y * 0.06, s.z * 0.3), Vector3(0, -s.y * 0.47, s.z * 0.35), _m(Color("d8dde3")))
			_add_box(Vector3(0.025, 0.012, 0.01), Vector3(s.x * 0.38, s.y * 0.25, s.z * 0.51), _glow(Color("3fb950")))
		"odu":
			var ring := MeshInstance3D.new()
			var tm := TorusMesh.new()
			tm.inner_radius = s.y * 0.3
			tm.outer_radius = s.y * 0.36
			ring.mesh = tm
			ring.material_override = dark
			ring.rotation.x = PI / 2
			ring.position = Vector3(s.x * 0.15, 0, s.z * 0.51)
			body.add_child(ring)
			for i in 5:
				_add_box(Vector3(s.y * 0.66, 0.01, 0.01), Vector3(s.x * 0.15, -s.y * 0.26 + i * s.y * 0.13, s.z * 0.52), dark)
			for i in 8:
				_add_box(Vector3(0.01, s.y * 0.8, 0.01), Vector3(-s.x * 0.45 + i * 0.02, 0, s.z * 0.51), metal)
		"camera":
			var dome := MeshInstance3D.new()
			var sm := SphereMesh.new()
			sm.radius = s.x * 0.45
			sm.height = s.x * 0.9
			dome.mesh = sm
			dome.material_override = _m(Color(0.15, 0.17, 0.2, 0.85), 0.3, 0.1)
			dome.position = Vector3(0, -s.y * 0.4, s.z * 0.2)
			body.add_child(dome)
			_add_box(Vector3(0.01, 0.01, 0.01), Vector3(s.x * 0.3, s.y * 0.2, s.z * 0.5), _glow(Color("f85149")))
		"light":
			body.mesh = _cyl(s.x * 0.5, s.y)
			_add_cyl(s.x * 0.42, s.y * 0.2, Vector3(0, -s.y * 0.55, 0), _glow(Color(1.0, 0.95, 0.82)))
		"speaker", "purifier", "vacuum":
			body.mesh = _cyl(minf(s.x, s.z) * 0.5, s.y)
			if type == "speaker":
				_add_cyl(minf(s.x, s.z) * 0.5, s.y * 0.06, Vector3(0, s.y * 0.5, 0), _glow(Color("4c8dff")))
			elif type == "purifier":
				for i in 6:
					_add_box(Vector3(s.x * 0.8, 0.008, 0.01), Vector3(0, s.y * 0.1 + i * 0.03, s.z * 0.5), dark)
		"tv":
			_add_box(Vector3(s.x * 0.94, s.y * 0.88, 0.005), Vector3(0, 0, s.z * 0.5 + 0.003), _glow(Color("2b4f8f")))
		"fridge":
			_add_box(Vector3(s.x * 0.98, 0.006, 0.006), Vector3(0, s.y * 0.15, s.z * 0.5), dark)
			for y in [0.32, -0.05]:
				_add_box(Vector3(0.02, s.y * 0.18, 0.03), Vector3(s.x * 0.4, s.y * y, s.z * 0.52), metal)
		"washer", "dryer":
			var door := MeshInstance3D.new()
			var tm := TorusMesh.new()
			tm.inner_radius = s.x * 0.24
			tm.outer_radius = s.x * 0.32
			door.mesh = tm
			door.material_override = metal
			door.rotation.x = PI / 2
			door.position = Vector3(0, -s.y * 0.05, s.z * 0.51)
			body.add_child(door)
			_add_cyl(s.x * 0.24, 0.01, Vector3(0, -s.y * 0.05, s.z * 0.5), _m(Color(0.3, 0.45, 0.6, 0.6), 0.2, 0.05), true)
			_add_box(Vector3(s.x * 0.9, s.y * 0.12, 0.01), Vector3(0, s.y * 0.4, s.z * 0.51), dark)
		"oven":
			_add_box(Vector3(s.x * 0.8, s.y * 0.5, 0.005), Vector3(0, -s.y * 0.05, s.z * 0.51), _m(Color(0.1, 0.1, 0.12, 0.9), 0.3, 0.05))
			_add_box(Vector3(s.x * 0.7, 0.02, 0.03), Vector3(0, s.y * 0.28, s.z * 0.53), metal)
		"fan":
			body.mesh = _cyl(0.17, 0.035)
			body.position.y = -s.y / 2 + 0.02
		"lock", "doorbell":
			_add_box(Vector3(s.x * 0.7, s.y * 0.4, 0.004), Vector3(0, s.y * 0.1, s.z * 0.5 + 0.003), _glow(Color("4c8dff")))


func _m(c: Color, metal := 0.0, rough := 0.5) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = c
	m.metallic = metal
	m.roughness = rough
	if c.a < 1.0:
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	return m


func _glow(c: Color) -> StandardMaterial3D:
	var m := _m(c)
	m.emission_enabled = true
	m.emission = c
	m.emission_energy_multiplier = 2.0
	return m


func _add_box(sz: Vector3, p: Vector3, m: Material) -> void:
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = sz
	mi.mesh = bm
	mi.material_override = m
	mi.position = p
	body.add_child(mi)


func _cyl(r: float, h: float) -> CylinderMesh:
	var cm := CylinderMesh.new()
	cm.top_radius = r
	cm.bottom_radius = r
	cm.height = h
	cm.radial_segments = 20
	return cm


func _add_cyl(r: float, h: float, p: Vector3, m: Material, facing_z := false) -> void:
	var mi := MeshInstance3D.new()
	mi.mesh = _cyl(r, h)
	mi.material_override = m
	mi.position = p
	if facing_z:
		mi.rotation.x = PI / 2
	body.add_child(mi)
