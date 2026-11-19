class_name Interior
extends Node3D
## Interiors read from the floor plan (Store.furniture): columns, seating, tables, desks, workstation pods,
## sanitary ware, stairs, gym equipment and so on, drawn with GPU instancing.
##
## Chairs, desks, tables, sofas, beds, bookcases, sinks, toilets, plants and the computers on every desk are
## modelled glTF assets (Kenney Furniture Kit, CC0, assets/furniture/kenney). Each model is split into its
## surfaces, fitted to the item's footprint and recoloured to an office palette through its material names.
## Kinds with no fitting model (columns, stairs, doors, pod partitions, gym kit, screens, railings) stay procedural.
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
	"frame": [Color("6b7078"), 0.6, 0.35], "arc": [Color("7aa7ff"), 0.0, 1.0], "glass": [Color(0.75, 0.88, 0.95, 0.28), 0.1, 0.05],
	"mirror": [Color("cfd8e3"), 1.0, 0.05], "monitor": [Color("1a1c20"), 0.3, 0.3], "display": [Color("5b8def"), 0.0, 0.3],
	"keyboard": [Color("30343b"), 0.1, 0.6], "cushion": [Color("a3876f"), 0.0, 0.9], "leaf": [Color("3f7f3b"), 0.0, 0.85],
	"partition2": [Color("d6dbe1"), 0.0, 0.5], "slide": [Color("e9f1ff"), 0.0, 0.4],
	"wood_dark": [Color("8a6446"), 0.0, 0.55], "porcelain": [Color("f7f8fa"), 0.05, 0.15], "chrome": [Color("d4d8dd"), 0.55, 0.3],
	"mesh_black": [Color("23262c"), 0.1, 0.7], "soil": [Color("4a3a2c"), 0.0, 0.95],
}
const MODEL_DIR := "res://assets/furniture/kenney/"
## Kenney material name -> palette key (the kit's pastel colours read as toys in an office)
const RECOLOUR := {
	"wood": "wood", "woodDark": "wood_dark", "carpet": "fabric", "carpetWhite": "porcelain", "carpetDark": "mesh_black", "carpetDarker": "rail",
	"metal": "chrome", "metalLight": "porcelain", "metalMedium": "frame", "metalDark": "dark", "plant": "leaf",
	"_defaultMat": "porcelain", "glass": "glass", "paper": "white", "darkWood": "wood_dark",
}
const GLOW := ["led", "console", "display", "slide"]
const TEXTURED := {"wood": 0.5, "fabric": 0.25, "sofa": 0.3, "cushion": 0.3, "concrete": 1.2, "stair": 0.8, "desk_top": 0.6}

var counts := {}         # kind -> number of items built (for the HUD / tests)
var _batches := {}       # "mesh|material" -> Array[Transform3D]
var _it := Transform3D() # item frame, scaled to its footprint (x, z in fractions of w, d; y in metres)
var _ir := Transform3D() # item frame, unscaled (metres)
var _w := 1.0
var _d := 1.0
var _meshes := {}
var _mats := {}
var _models := {}        # model name -> {parts: [[mesh key, Transform3D, material name]], box: AABB}
var _swap := {}          # per-item material swaps (e.g. sofa fabric), set by the recipe before _model()


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
	if k.begins_with("m:"):
		push_error("model mesh missing: " + k)
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
	if p[0].a < 1.0:
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	if k == "arc":
		m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	if TEXTURED.has(k):
		# subtle grain/weave so large surfaces don't look flat; world triplanar keeps scale constant on instanced parts
		var n := FastNoiseLite.new()
		n.frequency = 0.08 if k == "wood" else 0.4
		n.fractal_octaves = 3
		var nt := NoiseTexture2D.new()
		nt.noise = n
		nt.width = 128
		nt.height = 128
		nt.seamless = true
		nt.color_ramp = Gradient.new()
		nt.color_ramp.set_color(0, Color(0.82, 0.82, 0.82))
		nt.color_ramp.set_color(1, Color(1.0, 1.0, 1.0))
		m.albedo_texture = nt
		m.uv1_triplanar = true
		m.uv1_world_triplanar = true
		m.uv1_scale = (Vector3.ONE / float(TEXTURED[k])) * (Vector3(1, 1, 6) if k == "wood" else Vector3.ONE)
	_mats[k] = m
	return m


func _emit(mesh: String, mat: String, t: Transform3D) -> void:
	_batches.get_or_add(mesh + "|" + mat, []).append(t)


## Loads a glTF model once and splits it into single-surface meshes (so each can be instanced with its own
## palette material), with their transforms relative to the model root and the model's overall box.
func _load_model(name: String) -> Dictionary:
	if _models.has(name):
		return _models[name]
	var info := {"parts": [], "box": AABB()}
	var sc := load(MODEL_DIR + name + ".glb") as PackedScene
	if sc == null:
		_models[name] = info
		return info
	var root: Node3D = sc.instantiate()
	var first := true
	var idx := 0
	for n in root.find_children("*", "MeshInstance3D", true, false):
		var mi := n as MeshInstance3D
		var t := Transform3D.IDENTITY
		var p: Node = mi
		while p != root:
			t = (p as Node3D).transform * t
			p = p.get_parent()
		var bb: AABB = t * mi.mesh.get_aabb()
		info.box = bb if first else info.box.merge(bb)
		first = false
		for si in mi.mesh.get_surface_count():
			var am := ArrayMesh.new()
			am.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, mi.mesh.surface_get_arrays(si))
			var mat := mi.mesh.surface_get_material(si)
			var key := "m:%s#%d" % [name, idx]
			idx += 1
			_meshes[key] = am
			info.parts.append([key, t, mat.resource_name if mat else "_defaultMat"])
	root.free()
	_models[name] = info
	return info


## Places a model in the current item frame (_ir): centred at `at` (metres, item frame), turned by `yaw`,
## its box stretched to w x h x d metres. h <= 0 keeps the model's proportions (uniform scale fitting w x d).
func _model(name: String, at: Vector3, w: float, d: float, h := 0.0, yaw := 0.0) -> void:
	var info := _load_model(name)
	if info.parts.is_empty():
		return
	var box: AABB = info.box
	var sz: Vector3 = box.size.max(Vector3.ONE * 0.001)
	# the footprint is given in the item frame; a quarter turn swaps the model's x and z
	var quarter := absf(sin(yaw)) > 0.7
	var fw := d if quarter else w
	var fd := w if quarter else d
	var sc: Vector3
	if h > 0.0:
		sc = Vector3(fw / sz.x, h / sz.y, fd / sz.z)
	else:
		var u := minf(fw / sz.x, fd / sz.z)
		sc = Vector3(u, u, u)
	var centre := Vector3(box.get_center().x, box.position.y, box.get_center().z)
	var place := _ir * Transform3D(Basis(Vector3.UP, yaw) * Basis.from_scale(sc), at) * Transform3D(Basis.IDENTITY, -centre)
	for part in info.parts:
		var matname: String = part[2]
		var pal: String = _swap.get(matname, RECOLOUR.get(matname, "white"))
		_emit(part[0], pal, place * (part[1] as Transform3D))


## Part in footprint fractions (x, z) and metres (y).
func _b(mat: String, c: Vector3, s: Vector3, mesh := "box") -> void:
	_emit(mesh, mat, _it * Transform3D(Basis.from_scale(s), c))


## Part in metres.
func _bm(mat: String, c: Vector3, s: Vector3, mesh := "box") -> void:
	_emit(mesh, mat, _ir * Transform3D(Basis.from_scale(s), c))


## A monitor on a stand and a keyboard for one seat, in the current item frame (_ir); the user sits on the -z side.
func _setup(x: float, dd: float) -> void:
	# glTF monitor, keyboard and mouse; the kit's models face +z, so they are turned to face the seat
	_swap = {"metal": "display", "metalDark": "monitor"}
	_model("computerScreen", Vector3(x, 0.755, dd * 0.28), 0.56, 0.15, 0.42, PI)
	_swap = {"metal": "keyboard", "metalDark": "monitor"}
	_model("computerKeyboard", Vector3(x - 0.03, 0.755, -dd * 0.12), 0.44, 0.16, 0.025, PI)
	_model("computerMouse", Vector3(x + 0.27, 0.755, -dd * 0.12), 0.06, 0.1, 0.035, PI)
	_swap = {}


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
			# meeting / training chair: cushioned seat and back on a wooden frame
			_swap = {"carpet": "chair"}
			_model("chairCushion", Vector3.ZERO, w * 0.95, d * 0.95)
			_swap = {}
		"task_chair":
			# office chair on a five-star base with casters and armrests
			_swap = {"carpet": "fabric", "metalMedium": "dark"}
			_model("chairDesk", Vector3.ZERO, w, d)
			_swap = {}
		"table":
			_swap = {"wood": "desk_top"}
			_model("table", Vector3.ZERO, w, d, 0.75)
			_swap = {}
		"round_table":
			_model("tableRound", Vector3.ZERO, w, d, 0.75)
		"desk":
			# the kit's desk has its drawers and knee space on +z; ours seats the user on -z
			_swap = {"wood": "desk_top", "metal": "desk_frame"}
			_model("desk", Vector3.ZERO, w, d, 0.75, PI)
			_swap = {}
			var seats := maxi(1, roundi(w / 0.66))
			for i in seats:
				_setup(-w / 2 + w * (i + 0.5) / seats, d)
		"workstation":
			# a four-seat pod: shared top, cross dividers, end frames, a task chair at each seat
			_b("desk_top", Vector3(0, 0.74, 0), Vector3(0.96, 0.035, 0.62))
			_b("partition", Vector3(0, 0.98, 0), Vector3(0.96, 0.45, 0.025))
			_b("partition", Vector3(0, 0.98, 0), Vector3(0.025, 0.45, 0.62))
			for sx in [-0.47, 0.47]:
				_b("desk_frame", Vector3(sx, 0.37, 0), Vector3(0.02, 0.72, 0.6))
			var it := _it
			var ir := _ir
			for sx in [-0.25, 0.25]:  # a screen and keyboard at each of the four seats
				for sz in [-1, 1]:
					var face := 0.0 if sz < 0 else PI
					_ir = ir * Transform3D(Basis(Vector3.UP, face), Vector3(sx * w, 0, sz * d * 0.17))
					_setup(0.0, d * 0.28)
			_ir = ir
			for sx in [-0.25, 0.25]:
				for sz in [-1, 1]:
					var p := ir * Vector3(sx * w, 0, sz * (d * 0.31 + 0.32))
					_item("task_chair", p, 0.55, 0.55, rot + (0.0 if sz < 0 else PI))
			_it = it
			_ir = ir
		"sofa", "armchair":
			_swap = {"carpet": "sofa", "wood": "wood_dark"}
			if kind == "armchair" or w < 1.2:
				_model("loungeChair", Vector3.ZERO, w, d, minf(w, d) * 0.95)
			else:
				_model("loungeSofaLong" if w > 2.6 else "loungeSofa", Vector3.ZERO, w, d, 0.82)
			_swap = {}
		"bed":
			_swap = {"carpet": "linen", "carpetWhite": "white", "wood": "wood"}
			# the model's length runs along its z; turn it when the plan's bed is longer across than deep
			_model("bedSingle", Vector3.ZERO, w, d, 0.6, PI / 2 if w > d else 0.0)
			_swap = {}
		"cabinet":
			_swap = {"metal": "stone", "woodDark": "wood_dark"}
			_model("kitchenCabinet", Vector3.ZERO, w, d, minf(h, 0.9))
			_swap = {}
		"shelf":
			var sh := minf(h - 0.2, 1.8)
			var turn := PI / 2 if d > w * 1.5 else 0.0  # a run of shelving traced deeper than wide
			_model("bookcaseOpen", Vector3.ZERO, w, d, sh, turn)
			var run := maxf(w, d)
			var deep := minf(w, d)
			for r in 3:  # books on the lower three shelves
				var off := Vector3(-run * 0.15, 0.06 + r * sh / 4.0, 0)
				if turn != 0.0:
					off = Vector3(0, off.y, -run * 0.15)
				_model("books", off, run * 0.5 if turn == 0.0 else deep * 0.7, deep * 0.7 if turn == 0.0 else run * 0.5, 0.24, turn)
		"rack":
			_b("dark", Vector3(0, minf(h, 1.1) / 2, 0), Vector3(1, minf(h, 1.1), 1))
			for y in [0.3, 0.55, 0.8]:
				_b("led", Vector3(0, y, 0.51), Vector3(0.6, 0.03, 0.02))
		"counter":
			_b("counter", Vector3(0, 0.43, 0), Vector3(1, 0.86, 1))
			_b("stone", Vector3(0, 0.88, 0), Vector3(1.02, 0.04, 1.05))
		"sink":
			_swap = {"carpetWhite": "porcelain", "metal": "chrome", "metalLight": "porcelain"}
			_model("bathroomSink", Vector3.ZERO, w, d)
			_swap = {}
			_bm("mirror", Vector3(0, 1.35, -d * 0.48), Vector3(w * 0.9, 0.7, 0.02))
			_bm("frame", Vector3(0, 1.35, -d * 0.49), Vector3(w * 0.94, 0.74, 0.01))
		"toilet":
			for sx in [-1, 1]:  # cubicle side panels
				_bm("partition2", Vector3(sx * 0.6, 0.62, 0.15), Vector3(0.03, 1.0, 1.35))
			_swap = {"carpetWhite": "porcelain", "metalLight": "porcelain", "metalDark": "chrome"}
			_model("toilet", Vector3.ZERO, w * 0.9, d * 0.9)
			_swap = {}
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
			_bm("slide", Vector3(0, 1.05, 0.02), Vector3(w * 0.92, 0.85, 0.01))
			for sx in [-0.45, 0.45]:
				_bm("metal", Vector3(sx * w, 0.28, 0), Vector3(0.03, 0.56, 0.03), "cyl")
		"railing":
			var posts := maxi(2, ceili(w / 1.0) + 1)
			for i in posts:
				_bm("rail", Vector3(-w / 2 + w * i / (posts - 1), 0.5, 0), Vector3(0.04, 1.0, 0.04), "cyl")
			_bm("rail", Vector3(0, 1.0, 0), Vector3(w, 0.05, 0.05))
			_bm("glass", Vector3(0, 0.52, 0), Vector3(w, 0.86, 0.015))
		"treadmill":
			_b("dark", Vector3(0, 0.12, 0), Vector3(0.9, 0.18, 1))
			_b("belt", Vector3(0, 0.22, -0.05), Vector3(0.7, 0.03, 0.85))
			for sx in [-0.42, 0.42]:
				_b("dark", Vector3(sx, 0.65, 0.42), Vector3(0.08, 1.0, 0.06))
				_b("metal", Vector3(sx, 0.95, 0.15), Vector3(0.05, 0.04, 0.55))
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
			_swap = {"wood": "pot", "woodDark": "soil"}
			_model("pottedPlant", Vector3.ZERO, w, d, maxf(0.9, w * 2.2))
			_swap = {}
		"door":
			# frame jambs, one or two leaves standing open 70 degrees towards +z, handle, and the swing drawn on the floor
			var lh := minf(h, 2.05) - 0.02
			for sx in [-1, 1]:
				_bm("frame", Vector3(sx * (w / 2 + 0.025), lh / 2, 0), Vector3(0.05, lh, 0.14))
			var leaves := 2 if w > 1.2 else 1
			var lw := w / leaves
			for li in leaves:
				var side := -1.0 if li == 0 else 1.0  # hinge at -w/2 or +w/2; the leaf reaches towards the middle
				var hinge := Vector3(side * w / 2, 0, 0)
				var leaf := Transform3D(Basis(Vector3.UP, deg_to_rad(70.0) * side), hinge)
				_emit("box", "door", _ir * leaf * Transform3D(Basis.from_scale(Vector3(lw - 0.02, lh, 0.04)), Vector3(-side * lw / 2, lh / 2, 0)))
				_emit("box", "metal", _ir * leaf * Transform3D(Basis.from_scale(Vector3(0.12, 0.025, 0.06)), Vector3(-side * (lw - 0.12), 0.95, 0)))
				for k in 9:  # quarter-circle swing arc on the floor
					var a := deg_to_rad(90.0) * (k + 0.5) / 9.0
					var p := hinge + Vector3(-side * cos(a) * lw, 0.006, sin(a) * lw)
					var seg := Basis(Vector3.UP, side * a) * Basis.from_scale(Vector3(lw * 0.17, 0.004, 0.012))
					_emit("box", "arc", _ir * Transform3D(seg, p))
		_:
			counts[kind] -= 1
			_b("goods", Vector3(0, 0.4, 0), Vector3(1, 0.8, 1))
