class_name Piping
extends Node3D
## Refrigerant piping from the outdoor unit to every indoor AC: a liquid line and a gas line per unit,
## routed up from the outdoor unit, along the ceiling and down to the AC. Flow speed and colour follow
## the scenario and each AC's health; trace() lights up one circuit.

const CEILING := 2.55
const RADIUS := 0.025
const LIQUID := Color("4c8dff")
const GAS := Color("ff8a3d")

var _runs := {}  # ac id -> Array[ShaderMaterial]
var traced := ""  # AC id whose circuit is traced; "" = none
var _shader := preload("res://shaders/pipe_flow.gdshader")


func build() -> void:
	var odu := _first("odu")
	if odu.is_empty():
		return
	var o := Vector3(odu.position[0], 0.4, odu.position[2])
	var i := 0
	for d in Store.devices:
		if d.type != "ac":
			continue
		var a := Vector3(d.position[0], d.position[1], d.position[2])
		var lane := 0.12 * i  # keep runs apart along the ceiling
		var mats: Array = []
		for side in [-1, 1]:
			var off := Vector3(0.05 * side, 0, 0.05 * side)
			var y := CEILING + lane * 0.15 + (0.04 if side > 0 else 0.0)
			var pts := [o + off, Vector3(o.x, y, o.z) + off, Vector3(a.x, y, o.z) + off, Vector3(a.x, y, a.z) + off, a + Vector3(0, 0.14, 0) + off]
			mats.append_array(_tube(pts, GAS if side > 0 else LIQUID, side > 0))
		_runs[d.id] = mats
		i += 1
	refresh()


func _first(type: String) -> Dictionary:
	for d in Store.devices:
		if d.type == type:
			return d
	return {}


func _tube(pts: Array, color: Color, reverse: bool) -> Array:
	var mats: Array = []
	var run := 0.0
	for k in range(pts.size() - 1):
		var a: Vector3 = pts[k]
		var b: Vector3 = pts[k + 1]
		var len := a.distance_to(b)
		if len < 0.01:
			continue
		var m := MeshInstance3D.new()
		var cm := CylinderMesh.new()
		cm.top_radius = RADIUS
		cm.bottom_radius = RADIUS
		cm.height = len
		cm.radial_segments = 10
		cm.rings = 1
		m.mesh = cm
		var mat := ShaderMaterial.new()
		mat.shader = _shader
		mat.set_shader_parameter("base_color", color)
		mat.set_shader_parameter("seg_len", len)
		mat.set_shader_parameter("offset", run)
		mat.set_meta("reverse", reverse)
		m.material_override = mat
		add_child(m)
		# Align the cylinder's Y axis from a to b. UV.y = 0 is the top (b), so flow runs a -> b.
		var y := (b - a).normalized()
		var x := y.cross(Vector3.FORWARD if absf(y.dot(Vector3.FORWARD)) < 0.9 else Vector3.RIGHT).normalized()
		m.global_transform = Transform3D(Basis(x, y, x.cross(y).normalized()).orthonormalized(), (a + b) / 2)
		run += len
		mats.append(mat)
	return mats


## Flow speed per circuit: normal 0.6 m/s; watch slows to 0.3; fault nearly stops.
func refresh() -> void:
	for id in _runs:
		var h: String = Store.health.get(id, "ok")
		var spd := 0.6 if h == "ok" else (0.3 if h == "watch" else 0.08)
		for mat in _runs[id]:
			var s := -spd if mat.get_meta("reverse") else spd
			mat.set_shader_parameter("speed", s)
			mat.set_shader_parameter("glow", 1.0 if traced == "" else (2.2 if id == traced else 0.25))


func trace(from_id: String) -> void:
	traced = from_id if _runs.has(from_id) else ""
	refresh()
