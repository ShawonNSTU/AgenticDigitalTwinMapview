class_name FloorBuilder
extends Node3D
## Builds floor slabs, cut-away walls and room labels from res://data/building.json.

const SLAB := 0.08
const WALL := 0.08

var _slabs := {}  # room key -> StandardMaterial3D


func build() -> void:
	var walls := {}
	for r in Store.rooms:
		var x0: float = r.x[0]
		var x1: float = r.x[1]
		var z0: float = r.z[0]
		var z1: float = r.z[1]
		var mat := StandardMaterial3D.new()
		mat.albedo_color = Color(r.color).lerp(Color("d9dde3"), 0.55)
		mat.roughness = 0.9
		_slabs[r.key] = mat
		_box(Vector3((x0 + x1) / 2, -SLAB / 2, (z0 + z1) / 2), Vector3(x1 - x0 - 0.02, SLAB, z1 - z0 - 0.02), mat)
		for e in [[x0, z0, x1, z0], [x0, z1, x1, z1], [x0, z0, x0, z1], [x1, z0, x1, z1]]:
			walls["%.2f,%.2f,%.2f,%.2f" % e] = e  # shared edges are built once
		var label := Label3D.new()
		label.text = r.name
		label.font_size = 48
		label.pixel_size = 0.004
		label.modulate = Color(0.15, 0.18, 0.22, 0.75)
		label.outline_size = 0
		label.rotation = Vector3(-PI / 2, 0, 0)
		label.position = Vector3((x0 + x1) / 2, 0.01, (z0 + z1) / 2)
		add_child(label)
	var wall_mat := StandardMaterial3D.new()
	wall_mat.albedo_color = Color("f2f3f5")
	wall_mat.roughness = 0.8
	var h: float = Store.wall_height
	for e in walls.values():
		var a := Vector3(e[0], 0, e[1])
		var b := Vector3(e[2], 0, e[3])
		var size := Vector3(maxf(absf(b.x - a.x), WALL), h, maxf(absf(b.z - a.z), WALL))
		_box((a + b) / 2 + Vector3(0, h / 2, 0), size, wall_mat)
	if Store.outdoor_pad.has("x"):
		var pad := StandardMaterial3D.new()
		pad.albedo_color = Color("9aa3ad")
		_box(Vector3(Store.outdoor_pad.x, -0.02, Store.outdoor_pad.z), Vector3(1.6, 0.04, 1.2), pad)
	var ground := StandardMaterial3D.new()
	ground.albedo_color = Color("1a2028")
	_box(Vector3(-2.5, -SLAB - 0.03, -3.5), Vector3(60, 0.02, 60), ground)


## Tint rooms by the worst device health inside them (the "temperature" layer stand-in).
func tint_rooms(on: bool) -> void:
	for r in Store.rooms:
		var worst := "ok"
		for d in Store.devices:
			if d.room == r.key:
				var h: String = Store.health.get(d.id, "ok")
				if h == "fault" or (h == "watch" and worst == "ok"):
					worst = h
		var base := Color(r.color).lerp(Color("d9dde3"), 0.55)
		_slabs[r.key].albedo_color = base.lerp(Store.color_for(worst), 0.45) if on and worst != "ok" else base


func _box(pos: Vector3, size: Vector3, mat: Material) -> void:
	var m := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = size
	m.mesh = mesh
	m.material_override = mat
	m.position = pos
	add_child(m)
