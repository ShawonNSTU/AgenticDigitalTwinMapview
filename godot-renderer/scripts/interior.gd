class_name Interior
extends Node3D
## Interiors read from the floor plan (Store.furniture): columns, seating, tables, desks, workstation pods,
## sanitary ware, stairs, gym equipment and so on, built procedurally and drawn with GPU instancing.
##
## Each item: {kind, x, z, w, d, rot}. w is the size across, d front to back (metres), rot the facing
## direction (0 faces +z). Every kind is a small recipe of boxes/cylinders in the item's frame; all parts that
## share a mesh and material across the floor go into one MultiMeshInstance3D, so hundreds of chairs cost a
## handful of draw calls (Forward+ and the web build alike).

const PALETTE := {
	"concrete": [Color("9aa0a6"), 0.0, 0.85], "chair": [Color("5f7d8c"), 0.0, 0.6], "metal": [Color("b7bcc2"), 0.8, 0.3],
	"wood": [Color("c8a27a"), 0.0, 0.55], "fabric": [Color("3d5a99"), 0.0, 0.8], "dark": [Color("2a2d33"), 0.2, 0.5],
	"desk_top": [Color("ece7de"), 0.0, 0.45], "desk_frame": [Color("8c9198"), 0.5, 0.4], "partition": [Color("9fb3c8"), 0.0, 0.7],
	"sofa": [Color("8a6f5a"), 0.0, 0.85], "white": [Color("f3f4f6"), 0.0, 0.25], "linen": [Color("e5e7eb"), 0.0, 0.8],
	"goods": [Color("c9b38f"), 0.0, 0.8], "counter": [Color("d9d3c7"), 0.0, 0.6], "stone": [Color("6b7280"), 0.1, 0.35],
	"stair": [Color("c3c8cf"), 0.0, 0.7], "screen": [Color("f8fafc"), 0.0, 0.3], "rail": [Color("b03a2e"), 0.4, 0.4],
	"belt": [Color("141518"), 0.0, 0.9], "plant": [Color("4f8f4a"), 0.0, 0.8], "pot": [Color("8d6e63"), 0.0, 0.7],
	"led": [Color("3fb950"), 0.0, 0.5], "console": [Color("3b82f6"), 0.0, 0.4], "door": [Color("b08d6b"), 0.0, 0.6],
}
const GLOW := ["led", "console"]

var counts := {}         # kind -> number of items built (for the HUD / tests)
var _batches := {}       # "mesh|material" -> Array[Transform3D]
var _it := Transform3D() # item frame, scaled to its footprint (x, z in fractions of w, d; y in metres)
var _ir := Transform3D() # item frame, unscaled (metres)
var _w := 1.0
var _d := 1.0
var _meshes := {}
var _mats := {}


func build(items: Array) -> void:
	for f in items:
		_item(str(f.get("kind", "")), Vector3(float(f.x), 0, float(f.z)), float(f.w), float(f.d), float(f.get("rot", 0.0)))
	for key in _batches:
		var parts: PackedStringArray = key.split("|")
		var xs: Array = _batches[key]
		var mm := MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_3D
		mm.mesh = _mesh(parts[0])
		mm.instance_count = xs.size()
		for i in xs.size():
			mm.set_instance_transform(i, xs[i])
		var mi := MultiMeshInstance3D.new()
		mi.multimesh = mm
		mi.material_override = _mat(parts[1])
		mi.name = key.replace("|", "_")
		add_child(mi)


func draw_calls() -> int:
	return _batches.size()


func _mesh(k: String) -> Mesh:
	if _meshes.has(k):
		return _meshes[k]
	var m: Mesh
	match k:
		"cyl":
			var c := CylinderMesh.new()
			c.top_radius = 0.5
			c.bottom_radius = 0.5
			c.height = 1.0
			c.radial_segments = 14
			c.rings = 1
			m = c
		"sphere":
			var s := SphereMesh.new()
			s.radius = 0.5
			s.height = 1.0
			s.radial_segments = 12
			s.rings = 6
			m = s
		_:
			var b := BoxMesh.new()
			b.size = Vector3.ONE
			m = b
	_meshes[k] = m
	return m


func _mat(k: String) -> StandardMaterial3D:
	if _mats.has(k):
		return _mats[k]
	var p: Array = PALETTE.get(k, [Color.MAGENTA, 0.0, 0.5])
	var m := StandardMaterial3D.new()
	m.albedo_color = p[0]
	m.metallic = p[1]
	m.roughness = p[2]
	if k in GLOW:
		m.emission_enabled = true
		m.emission = p[0]
		m.emission_energy_multiplier = 1.5
	_mats[k] = m
	return m


func _emit(mesh: String, mat: String, t: Transform3D) -> void:
	_batches.get_or_add(mesh + "|" + mat, []).append(t)


## Part in footprint fractions (x, z) and metres (y).
func _b(mat: String, c: Vector3, s: Vector3, mesh := "box") -> void:
	_emit(mesh, mat, _it * Transform3D(Basis.from_scale(s), c))


## Part in metres.
func _bm(mat: String, c: Vector3, s: Vector3, mesh := "box") -> void:
	_emit(mesh, mat, _ir * Transform3D(Basis.from_scale(s), c))


func _item(kind: String, at: Vector3, w: float, d: float, rot: float) -> void:
	var basis := Basis(Vector3.UP, rot)
	_ir = Transform3D(basis, at)
	_it = Transform3D(basis * Basis.from_scale(Vector3(w, 1, d)), at)
	_w = w
	_d = d
	var h: float = Store.wall_height
	counts[kind] = counts.get(kind, 0) + 1
	match kind:
		"column":
			_b("concrete", Vector3(0, h / 2, 0), Vector3(1, h, 1))
		"chair":
			_b("chair", Vector3(0, 0.45, 0.02), Vector3(0.9, 0.05, 0.85))
			_b("chair", Vector3(0, 0.72, -0.42), Vector3(0.9, 0.5, 0.08))
			for sx in [-0.38, 0.38]:
				for sz in [-0.36, 0.36]:
					_b("metal", Vector3(sx, 0.22, sz), Vector3(0.07, 0.44, 0.07), "cyl")
		"task_chair":
			_b("fabric", Vector3(0, 0.47, 0.05), Vector3(0.85, 0.08, 0.8))
			_b("fabric", Vector3(0, 0.78, -0.4), Vector3(0.8, 0.5, 0.1))
			_bm("metal", Vector3(0, 0.25, 0), Vector3(0.05, 0.42, 0.05), "cyl")
			_b("dark", Vector3(0, 0.03, 0), Vector3(0.9, 0.04, 0.9), "cyl")
		"table":
			_b("wood", Vector3(0, 0.73, 0), Vector3(1, 0.04, 1))
			for sx in [-1, 1]:
				for sz in [-1, 1]:
					_bm("metal", Vector3(sx * (w / 2 - 0.06), 0.36, sz * (d / 2 - 0.06)), Vector3(0.05, 0.71, 0.05), "cyl")
		"round_table":
			_b("wood", Vector3(0, 0.73, 0), Vector3(1, 0.04, 1), "cyl")
			_bm("metal", Vector3(0, 0.36, 0), Vector3(0.07, 0.7, 0.07), "cyl")
			_bm("dark", Vector3(0, 0.02, 0), Vector3(minf(w, 0.5), 0.03, minf(d, 0.5)), "cyl")
		"desk":
			_b("desk_top", Vector3(0, 0.74, 0), Vector3(1, 0.035, 1))
			for sx in [-1, 1]:
				_bm("desk_frame", Vector3(sx * (w / 2 - 0.02), 0.37, 0), Vector3(0.04, 0.72, d * 0.9))
			_bm("desk_frame", Vector3(0, 0.45, d / 2 - 0.02), Vector3(w * 0.9, 0.4, 0.02))
		"workstation":
			# a four-seat pod: shared top, cross dividers, end frames, a task chair at each seat
			_b("desk_top", Vector3(0, 0.74, 0), Vector3(0.96, 0.035, 0.62))
			_b("partition", Vector3(0, 0.98, 0), Vector3(0.96, 0.45, 0.025))
			_b("partition", Vector3(0, 0.98, 0), Vector3(0.025, 0.45, 0.62))
			for sx in [-0.47, 0.47]:
				_b("desk_frame", Vector3(sx, 0.37, 0), Vector3(0.02, 0.72, 0.6))
			var it := _it
			var ir := _ir
			for sx in [-0.25, 0.25]:
				for sz in [-1, 1]:
					var p := ir * Vector3(sx * w, 0, sz * (d * 0.31 + 0.32))
					_item("task_chair", p, 0.55, 0.55, rot + (0.0 if sz < 0 else PI))
			_it = it
			_ir = ir
		"sofa", "armchair":
			_b("sofa", Vector3(0, 0.22, 0.05), Vector3(1, 0.36, 0.9))
			_b("sofa", Vector3(0, 0.55, -0.38), Vector3(1, 0.42, 0.24))
			for sx in [-0.45, 0.45]:
				_b("sofa", Vector3(sx, 0.4, 0.05), Vector3(0.1, 0.32, 0.9))
		"bed":
			_b("wood", Vector3(0, 0.18, 0), Vector3(1, 0.3, 1))
			_b("linen", Vector3(0, 0.39, 0.02), Vector3(0.96, 0.14, 0.94))
			_b("white", Vector3(0, 0.5, -0.38), Vector3(0.6, 0.08, 0.16))
		"cabinet":
			_b("wood", Vector3(0, minf(h, 1.1) / 2, 0), Vector3(1, minf(h, 1.1), 1))
		"shelf":
			var sh := minf(h, 1.1)
			for sx in [-0.48, 0.48]:
				_b("metal", Vector3(sx, sh / 2, 0), Vector3(0.04, sh, 1))
			for y in [0.08, 0.42, 0.76, sh - 0.02]:
				_b("wood", Vector3(0, y, 0), Vector3(1, 0.03, 1))
				if y < sh - 0.1:
					_b("goods", Vector3(0, y + 0.13, 0), Vector3(0.85, 0.22, 0.7))
		"rack":
			_b("dark", Vector3(0, minf(h, 1.1) / 2, 0), Vector3(1, minf(h, 1.1), 1))
			for y in [0.3, 0.55, 0.8]:
				_b("led", Vector3(0, y, 0.51), Vector3(0.6, 0.03, 0.02))
		"counter":
			_b("counter", Vector3(0, 0.43, 0), Vector3(1, 0.86, 1))
			_b("stone", Vector3(0, 0.88, 0), Vector3(1.02, 0.04, 1.05))
		"sink":
			_b("white", Vector3(0, 0.88, 0), Vector3(1, 0.12, 1), "cyl")
			_bm("metal", Vector3(0, 0.98, -d * 0.45), Vector3(0.03, 0.16, 0.03), "cyl")
		"toilet":
			_b("white", Vector3(0, 0.2, 0.1), Vector3(0.8, 0.4, 0.7), "cyl")
			_b("white", Vector3(0, 0.42, 0.1), Vector3(0.85, 0.04, 0.75), "cyl")
			_b("white", Vector3(0, 0.55, -0.38), Vector3(0.9, 0.45, 0.24))
		"stair":
			# real step count for the run length; rises towards +z (the facing direction)
			var n := maxi(3, roundi(d / 0.28))
			var tread := d / n
			var rise := minf(0.17, 1.6 / n)
			for i in n:
				var top := (i + 1) * rise
				_bm("stair", Vector3(0, top / 2, -d / 2 + (i + 0.5) * tread), Vector3(w, top, tread * 1.001))
			# handrails follow the pitch of the flight, 0.9 m above the nosings
			var climb := n * rise
			var pitch := atan2(climb, d)
			var length := sqrt(d * d + climb * climb)
			# one rail on the flight's right-hand side; in a switchback both flights' right sides are the outer walls
			var b := Basis(Vector3.RIGHT, -pitch) * Basis.from_scale(Vector3(0.04, 0.04, length))
			_emit("box", "metal", _ir * Transform3D(b, Vector3(w / 2 - 0.03, climb / 2 + 0.9, 0)))
		"screen":
			_bm("screen", Vector3(0, 1.05, 0), Vector3(w, 1.0, 0.03))
			for sx in [-0.45, 0.45]:
				_bm("metal", Vector3(sx * w, 0.28, 0), Vector3(0.03, 0.56, 0.03), "cyl")
		"railing":
			var posts := maxi(2, ceili(w / 1.0) + 1)
			for i in posts:
				_bm("rail", Vector3(-w / 2 + w * i / (posts - 1), 0.5, 0), Vector3(0.04, 1.0, 0.04), "cyl")
			_bm("rail", Vector3(0, 1.0, 0), Vector3(w, 0.05, 0.05))
			_bm("rail", Vector3(0, 0.5, 0), Vector3(w, 0.03, 0.03))
		"treadmill":
			_b("dark", Vector3(0, 0.12, 0), Vector3(0.9, 0.18, 1))
			_b("belt", Vector3(0, 0.22, -0.05), Vector3(0.7, 0.03, 0.85))
			for sx in [-0.42, 0.42]:
				_b("dark", Vector3(sx, 0.65, 0.42), Vector3(0.08, 1.0, 0.06))
			_b("console", Vector3(0, 1.15, 0.45), Vector3(0.9, 0.12, 0.1))
		"bike":
			_b("dark", Vector3(0, 0.4, 0), Vector3(0.35, 0.12, 0.9))
			_b("metal", Vector3(0, 0.68, -0.25), Vector3(0.15, 0.5, 0.06))
			_b("dark", Vector3(0, 0.95, -0.25), Vector3(0.7, 0.06, 0.3))
			_b("metal", Vector3(0, 0.82, 0.32), Vector3(0.15, 0.75, 0.06))
			_b("dark", Vector3(0, 1.18, 0.36), Vector3(1.6, 0.04, 0.06))
			_b("metal", Vector3(0, 0.3, 0.25), Vector3(0.12, 0.45, 0.45))
		"weight_rack":
			_b("dark", Vector3(0, 0.55, 0), Vector3(1, 0.05, 1))
			for sx in [-0.48, 0.48]:
				_b("dark", Vector3(sx, 0.27, 0), Vector3(0.03, 0.55, 0.9))
			var n := maxi(3, roundi(w / 0.22))
			for i in n:
				_bm("dark", Vector3(-w / 2 + w * (i + 0.5) / n, 0.65, 0), Vector3(0.12, 0.13, minf(0.32, d * 0.9)), "cyl")
		"plant":
			_b("pot", Vector3(0, 0.2, 0), Vector3(0.6, 0.4, 0.6), "cyl")
			_b("plant", Vector3(0, 0.75, 0), Vector3(1, 0.8, 1), "sphere")
		"door":
			_b("door", Vector3(0, 1.0, 0), Vector3(1, 2.0, 1))
		_:
			counts[kind] -= 1
			_b("goods", Vector3(0, 0.4, 0), Vector3(1, 0.8, 1))
