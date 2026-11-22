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
	"leaf_dark": [Color("2f6a35"), 0.0, 0.7], "planter": [Color("d9d5cc"), 0.0, 0.55], "rubber": [Color("2c2f34"), 0.0, 0.85],
	"steel": [Color("9ba3ad"), 0.55, 0.35], "box_kraft": [Color("b58b5a"), 0.0, 0.9], "duvet": [Color("eef0f3"), 0.0, 0.9],
	"cabinet_grey": [Color("cfd3d8"), 0.0, 0.5],
	"seat_blue": [Color("35598f"), 0.0, 0.85], "shell_dark": [Color("40454c"), 0.05, 0.42], "laminate": [Color("f1eee8"), 0.0, 0.32],
	"edge": [Color("3d4249"), 0.1, 0.4], "seat_grey": [Color("66707e"), 0.0, 0.85],
	"col_paint": [Color("efede8"), 0.0, 0.9], "col_skirt": [Color("4b5058"), 0.1, 0.55], "col_guard": [Color("d5d9de"), 0.25, 0.38],
	"col_gap": [Color("8c9096"), 0.0, 0.8],
	"concrete": [Color("9aa0a6"), 0.0, 0.85], "chair": [Color("5f7d8c"), 0.0, 0.6], "metal": [Color("b7bcc2"), 0.8, 0.3],
	"wood": [Color("c8a27a"), 0.0, 0.55], "fabric": [Color("3d5a99"), 0.0, 0.8], "dark": [Color("2a2d33"), 0.2, 0.5],
	"desk_top": [Color("ece7de"), 0.0, 0.45], "desk_frame": [Color("8c9198"), 0.5, 0.4], "partition": [Color("9fb3c8"), 0.0, 0.7],
	"sofa": [Color("8a6f5a"), 0.0, 0.85], "white": [Color("f3f4f6"), 0.0, 0.25], "linen": [Color("e5e7eb"), 0.0, 0.8],
	"goods": [Color("c9b38f"), 0.0, 0.8], "counter": [Color("d9d3c7"), 0.0, 0.6], "stone": [Color("6b7280"), 0.1, 0.35],
	"stair": [Color("c3c8cf"), 0.0, 0.7], "screen": [Color("f8fafc"), 0.0, 0.3], "rail": [Color("b03a2e"), 0.4, 0.4],
	"belt": [Color("141518"), 0.0, 0.9], "plant": [Color("4f8f4a"), 0.0, 0.8], "pot": [Color("8d6e63"), 0.0, 0.7],
	"led": [Color("3fb950"), 0.0, 0.5], "console": [Color("3b82f6"), 0.0, 0.4], "door": [Color("b08d6b"), 0.0, 0.6],
	"frame": [Color("6b7078"), 0.6, 0.35], "arc": [Color("7aa7ff"), 0.0, 1.0], "glass": [Color(0.75, 0.88, 0.95, 0.28), 0.1, 0.05],
	"mirror": [Color("c9d6e3"), 0.35, 0.12], "monitor": [Color("2a2e35"), 0.3, 0.3], "display": [Color("5b8def"), 0.0, 0.3],
	"keyboard": [Color("30343b"), 0.1, 0.6], "cushion": [Color("a3876f"), 0.0, 0.9], "leaf": [Color("3f7f3b"), 0.0, 0.85],
	"partition2": [Color("d6dbe1"), 0.0, 0.5], "slide": [Color("e9f1ff"), 0.0, 0.4],
	"wood_dark": [Color("8a6446"), 0.0, 0.55], "porcelain": [Color("f7f8fa"), 0.05, 0.15], "chrome": [Color("d4d8dd"), 0.55, 0.3],
	"mesh_black": [Color("23262c"), 0.1, 0.7], "soil": [Color("4a3a2c"), 0.0, 0.95],
	"water": [Color(0.45, 0.72, 0.95, 0.55), 0.0, 0.1], "warn": [Color("f2c94c"), 0.0, 0.5], "locker": [Color("aab7c4"), 0.3, 0.45],
	"tile": [Color("e8edf2"), 0.0, 0.3], "drinks": [Color("e85d4a"), 0.0, 0.5],
	"velvet": [Color("80868f"), 0.0, 0.95], "velvet_dark": [Color("565c65"), 0.0, 0.9], "maple": [Color("d8c4a0"), 0.0, 0.45], "brass": [Color("c9a24a"), 0.85, 0.3],
	"shade": [Color("17181b"), 0.1, 0.55], "shade_glow": [Color("ffcf8a"), 0.0, 0.5], "shade_inner": [Color("c9a46a"), 0.3, 0.45], "gloss_white": [Color("f4f4f2"), 0.0, 0.18],
	"book_red": [Color("c0392b"), 0.0, 0.6], "walnut": [Color("6e4a2f"), 0.0, 0.5], "poster": [Color("d8343f"), 0.0, 0.6],
	"frosted": [Color(0.86, 0.9, 0.93, 0.5), 0.05, 0.15],
	"door_frame": [Color("4a3a2e"), 0.0, 0.45],
	"steel_door": [Color("b9bdc3"), 0.55, 0.28], "box_blue": [Color("b9d3ea"), 0.0, 0.5], "exit_green": [Color("33e07a"), 0.0, 0.4],
	"bottle": [Color(0.32, 0.5, 0.85, 0.55), 0.1, 0.1], "bottle_cap": [Color("1d4fd1"), 0.0, 0.4],
}
const MODEL_DIR := "res://assets/furniture/kenney/"
## Kenney material name -> palette key (the kit's pastel colours read as toys in an office)
const RECOLOUR := {
	"wood": "wood", "woodDark": "wood_dark", "carpet": "fabric", "carpetWhite": "porcelain", "carpetDark": "mesh_black", "carpetDarker": "rail",
	"metal": "chrome", "metalLight": "porcelain", "metalMedium": "frame", "metalDark": "dark", "plant": "leaf",
	"_defaultMat": "porcelain", "glass": "glass", "paper": "white", "darkWood": "wood_dark",
}
const GLOW := ["led", "console", "display", "slide", "drinks", "shade_glow", "exit_green"]
const TEXTURED := {"velvet": 0.2, "walnut": 0.5, "wood": 0.5, "fabric": 0.25, "sofa": 0.3, "cushion": 0.3, "concrete": 1.2, "seat_blue": 0.25, "seat_grey": 0.25, "stair": 0.8, "desk_top": 0.6, "maple": 0.6}

var counts := {}         # kind -> number of items built (for the HUD / tests)


## Oak veneer for door leaves: fine vertical grain with a broad figure, made once.
static var _grain: ImageTexture
static func _door_grain() -> ImageTexture:
	if _grain:
		return _grain
	var n := 256
	var img := Image.create(n, n, false, Image.FORMAT_RGB8)
	var wander := FastNoiseLite.new()
	wander.seed = 9
	wander.frequency = 0.006
	var tone := FastNoiseLite.new()
	tone.seed = 13
	tone.frequency = 0.02
	var light := Color("c79a6b")
	var dark := Color("8c6240")
	for y in n:
		for x in n:
			var t := float(x) / n * 30.0 + wander.get_noise_2d(x * 0.5, y * 0.25) * 4.0
			var line := pow(0.5 + 0.5 * sin(t * TAU), 10.0)
			img.set_pixel(x, y, light.lerp(dark, clampf(line * 0.3 + (tone.get_noise_2d(x * 0.3, y) * 0.5 + 0.5) * 0.25, 0.0, 1.0)))
	img.generate_mipmaps()
	_grain = ImageTexture.create_from_image(img)
	return _grain
var _batches := {}       # "mesh|material" -> Array[Transform3D]
var _it := Transform3D() # item frame, scaled to its footprint (x, z in fractions of w, d; y in metres)
var _ir := Transform3D() # item frame, unscaled (metres)
var _w := 1.0
var _d := 1.0
var _meshes := {}
var _mats := {}
var _models := {}        # model name -> {parts: [[mesh key, Transform3D, material name]], box: AABB}
var _swap := {}          # per-item material swaps (e.g. sofa fabric), set by the recipe before _model()


var _cur: Dictionary = {}


func build(items: Array) -> void:
	# Rooms with lights get their own batches. On the web (Compatibility renderer) every omni/spot light draws each
	# object it touches once more; a floor-wide batch is touched by every light on the floor, a room's batch only
	# by that room's lights (the SmartThings zone's lights: ~2200 -> ~900 draw calls walking in it).
	var lit := {}
	for d in Store.devices:
		if str(d.get("type", "")) == "light":
			lit[str(d.get("room", ""))] = true
	for f in items:
		_cur = f
		var room := str(f.get("room", ""))
		if room == "":
			room = str(Store.room_at(Vector2(float(f.x), float(f.z))).get("key", ""))
		_cur_cell = room if lit.has(room) else "*"
		_item(str(f.get("kind", "")), Vector3(float(f.x), 0, float(f.z)), float(f.w), float(f.d), float(f.get("rot", 0.0)))
		if GROUNDED.has(str(f.get("kind", ""))) and float(f.w) * float(f.d) < 14.0:
			_shadows.append(Transform3D(Basis(Vector3.UP, float(f.get("rot", 0.0))) * Basis.from_scale(Vector3(float(f.w) * 1.25 + 0.2, 1, float(f.d) * 1.25 + 0.2)), Vector3(float(f.x), 0.012, float(f.z))))
	_contact_shadows()
	for key in _batches:
		var parts: PackedStringArray = key.split("|").slice(1)
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


## Furniture that stands on the floor gets a soft contact shadow under it (one instanced draw for the whole floor),
## so it sits on the floor instead of floating, on every renderer and quality tier.
const GROUNDED := ["bed", "bench", "bike", "bookcase_white", "cabinet", "chair", "coffee_table", "counter", "desk", "desk_one", "dispenser",
	"elec_panel", "floor_lamp", "locker", "mesh_chair", "plant", "rack", "round_table", "shelf", "sofa", "stool", "table", "task_chair",
	"toilet", "treadmill", "tufted_sofa", "tv_unit", "vending", "weight_rack", "workstation", "sink"]
var _shadows: Array = []


func _contact_shadows() -> void:
	if _shadows.is_empty():
		return
	var g := Gradient.new()
	g.set_color(0, Color(0, 0, 0, 0.42))
	g.set_color(1, Color(0, 0, 0, 0.0))
	g.add_point(0.55, Color(0, 0, 0, 0.28))
	var tex := GradientTexture2D.new()
	tex.gradient = g
	tex.fill = GradientTexture2D.FILL_RADIAL
	tex.fill_from = Vector2(0.5, 0.5)
	tex.fill_to = Vector2(1.0, 0.5)
	tex.width = 64
	tex.height = 64
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.albedo_texture = tex
	mat.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	var q := PlaneMesh.new()
	q.size = Vector2(1, 1)
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.mesh = q
	mm.instance_count = _shadows.size()
	for i in _shadows.size():
		mm.set_instance_transform(i, _shadows[i])
	var mi := MultiMeshInstance3D.new()
	mi.name = "ContactShadows"
	mi.multimesh = mm
	mi.material_override = mat
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
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
			c.radial_segments = 28
			c.rings = 1
			m = c
		"sphere":
			var s := SphereMesh.new()
			s.radius = 0.5
			s.height = 1.0
			s.radial_segments = 24
			s.rings = 12
			m = s
		"soft":
			m = bevel_box(0.2)   # cushions and upholstery: well-rounded edges
		_:
			m = bevel_box(0.045)
	_meshes[k] = m
	return m


## A unit box with its edges rounded off (chamfer c, normals blended across it), so furniture edges catch the
## light the way real furniture does instead of meeting at knife-sharp corners. 26 faces; shared by every box part.
static func bevel_box(c: float) -> ArrayMesh:
	return bevel_box_v(Vector3(c, c, c))


## The same with a chamfer per axis (in unit-box terms), so a box scaled to a real size can keep a round edge of
## the same real radius on every side.
static func bevel_box_v(c: Vector3) -> ArrayMesh:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var h := 0.5
	var e := Vector3(h, h, h) - c
	var fp := func(axis: int, sg: Vector3) -> Vector3:
		var q := sg * e
		q[axis] = sg[axis] * h
		return q
	var nrm := func(axis: int, sign: float) -> Vector3:
		var n := Vector3.ZERO
		n[axis] = sign
		return n
	var tri := func(pa: Vector3, pb: Vector3, pc: Vector3, na: Vector3, nb: Vector3, nc: Vector3, out: Vector3) -> void:
		if (pb - pa).cross(pc - pa).dot(out) > 0.0:   # Godot's front faces wind clockwise seen from outside
			var t := pb; pb = pc; pc = t
			var tn := nb; nb = nc; nc = tn
		for v in [[pa, na], [pb, nb], [pc, nc]]:
			st.set_normal(v[1])
			st.add_vertex(v[0])
	# the six faces, inset by the chamfer
	for axis in 3:
		var u := (axis + 1) % 3
		var w := (axis + 2) % 3
		for sign in [-1.0, 1.0]:
			var n: Vector3 = nrm.call(axis, sign)
			var q := []
			for su in [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]]:
				var sg := Vector3.ZERO
				sg[axis] = sign
				sg[u] = su[0]
				sg[w] = su[1]
				q.append(fp.call(axis, sg))
			tri.call(q[0], q[1], q[2], n, n, n, n)
			tri.call(q[0], q[2], q[3], n, n, n, n)
	# twelve edge strips: each side takes the normal of the face it meets, so the strip shades round
	for a in 3:
		var b := (a + 1) % 3
		var w := (a + 2) % 3
		for sa in [-1.0, 1.0]:
			for sb in [-1.0, 1.0]:
				var na: Vector3 = nrm.call(a, sa)
				var nb: Vector3 = nrm.call(b, sb)
				var p := []
				for sw in [-1.0, 1.0]:
					var sg := Vector3.ZERO
					sg[a] = sa
					sg[b] = sb
					sg[w] = sw
					p.append([fp.call(a, sg), fp.call(b, sg)])
				tri.call(p[0][0], p[1][0], p[1][1], na, na, nb, na + nb)
				tri.call(p[0][0], p[1][1], p[0][1], na, nb, nb, na + nb)
	# eight corner triangles
	for sx in [-1.0, 1.0]:
		for sy in [-1.0, 1.0]:
			for sz in [-1.0, 1.0]:
				var sg := Vector3(sx, sy, sz)
				tri.call(fp.call(0, sg), fp.call(1, sg), fp.call(2, sg), nrm.call(0, sx), nrm.call(1, sy), nrm.call(2, sz), sg)
	return st.commit()


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
	if k == "door":
		# veneered door leaf: oak grain running up the leaf (triplanar: stripes vary across, so they stand upright)
		m.albedo_color = Color.WHITE
		m.albedo_texture = _door_grain()
		m.uv1_triplanar = true
		m.uv1_world_triplanar = true
		m.uv1_scale = Vector3.ONE / 0.9
		m.roughness = 0.4
	elif TEXTURED.has(k):
		# subtle grain/weave so large surfaces don't look flat; world triplanar keeps scale constant on instanced parts
		var n := FastNoiseLite.new()
		n.frequency = 0.08 if k in ["wood", "walnut"] else 0.4
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
		m.uv1_scale = (Vector3.ONE / float(TEXTURED[k])) * (Vector3(1, 1, 6) if k in ["wood", "walnut"] else Vector3.ONE)
	_mats[k] = m
	return m


var _cur_cell := "*"   # batch cell of the item being built: its room if the room has lights, else the whole floor


func _emit(mesh: String, mat: String, t: Transform3D) -> void:
	_batches.get_or_add(_cur_cell + "|" + mesh + "|" + mat, []).append(t)


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


## A rounded (upholstered) part in metres, tilted back by tilt radians about its own x axis, its edges rounded to
## radius r whatever its size (one mesh per size, shared by every part that size).
func _soft(mat: String, c: Vector3, s: Vector3, tilt := 0.0, r := 0.03) -> void:
	var k := "rb:%d:%d:%d:%d" % [roundi(s.x * 100), roundi(s.y * 100), roundi(s.z * 100), roundi(r * 1000)]
	if not _meshes.has(k):
		_meshes[k] = bevel_box_v(Vector3(minf(r / maxf(s.x, 0.001), 0.45), minf(r / maxf(s.y, 0.001), 0.45), minf(r / maxf(s.z, 0.001), 0.45)))
	_emit(k, mat, _ir * Transform3D(Basis(Vector3.RIGHT, tilt) * Basis.from_scale(s), c))


## A round tube of radius r from a to b, in metres in the item frame.
func _tube(mat: String, a: Vector3, b: Vector3, r: float) -> void:
	var v := b - a
	var len := v.length()
	if len < 0.001:
		return
	var y := v / len
	var x := y.cross(Vector3.FORWARD if absf(y.z) < 0.9 else Vector3.RIGHT).normalized()
	var z := x.cross(y)
	_emit("cyl", mat, _ir * Transform3D(Basis(x * 2 * r, y * len, z * 2 * r), (a + b) / 2))


# ---- furniture built in code: real proportions and parts, so it holds up at eye level ----
# Every item faces +z: a chair's seat front is +z and its back -z; a desk's user sits on -z.

## Stacking chair (cafeteria, training): chrome tube legs, padded seat on a moulded shell, a padded back on two
## uprights leaning back.
func _stack_chair(w: float, d: float) -> void:
	var sw := clampf(w * 0.95, 0.4, 0.52)
	var sd := clampf(d * 0.95, 0.4, 0.52)
	var hx := sw / 2 - 0.03
	var hz := sd / 2 - 0.03
	for sx in [-1.0, 1.0]:
		for sz in [-1.0, 1.0]:
			_tube("chrome", Vector3(sx * hx, 0.44, sz * hz), Vector3(sx * (hx + 0.015), 0.0, sz * (hz + 0.02)), 0.011)
		_tube("chrome", Vector3(sx * hx, 0.02, -hz - 0.02), Vector3(sx * hx, 0.02, hz + 0.02), 0.009)   # floor runner
		_tube("chrome", Vector3(sx * hx, 0.44, -hz), Vector3(sx * (hx - 0.005), 0.88, -hz - 0.06), 0.01)
	_bm("shell_dark", Vector3(0, 0.448, 0), Vector3(sw, 0.022, sd))
	_soft("seat_blue", Vector3(0, 0.478, 0.008), Vector3(sw - 0.02, 0.05, sd - 0.03))
	_soft("shell_dark", Vector3(0, 0.72, -hz - 0.045), Vector3(sw - 0.02, 0.33, 0.03), -0.14)
	_soft("seat_blue", Vector3(0, 0.72, -hz - 0.025), Vector3(sw - 0.04, 0.29, 0.04), -0.14)


## Office chair: five-star base on casters, gas lift, padded seat, a back on its support bar, armrests.
func _task_chair(w: float, d: float, fabric: String) -> void:
	var r := clampf(minf(w, d) * 0.52, 0.26, 0.33)
	for i in 5:
		var a: float = TAU * i / 5.0 + 0.3
		var dir := Vector3(sin(a), 0, cos(a))
		_emit("box", "shell_dark", _ir * Transform3D(Basis(Vector3.UP, a) * Basis.from_scale(Vector3(0.045, 0.035, r)), dir * r / 2 + Vector3(0, 0.085, 0)))
		_bm("dark", dir * (r - 0.01) + Vector3(0, 0.03, 0), Vector3(0.05, 0.05, 0.05), "sphere")
	_bm("shell_dark", Vector3(0, 0.09, 0), Vector3(0.1, 0.06, 0.1), "cyl")
	_tube("chrome", Vector3(0, 0.1, 0), Vector3(0, 0.42, 0), 0.024)
	_bm("shell_dark", Vector3(0, 0.44, 0), Vector3(0.22, 0.05, 0.22))
	_bm("shell_dark", Vector3(0, 0.468, 0), Vector3(0.48, 0.025, 0.46))
	_soft(fabric, Vector3(0, 0.505, 0.01), Vector3(0.5, 0.075, 0.48))
	_tube("shell_dark", Vector3(0, 0.45, -0.18), Vector3(0, 0.66, -0.27), 0.022)
	_soft("shell_dark", Vector3(0, 0.88, -0.29), Vector3(0.46, 0.52, 0.035), -0.12)
	_soft(fabric, Vector3(0, 0.88, -0.27), Vector3(0.43, 0.48, 0.05), -0.12)
	for sx in [-1.0, 1.0]:
		_bm("shell_dark", Vector3(sx * 0.27, 0.57, -0.02), Vector3(0.03, 0.2, 0.05))
		_soft("shell_dark", Vector3(sx * 0.27, 0.68, 0.0), Vector3(0.065, 0.028, 0.26))


## Table: laminate top on a dark edge band, square steel legs in pairs with a foot rail, aprons under the top;
## a long (cafeteria) table gets a pair of legs every 1.8 m.
func _table(w: float, d: float) -> void:
	var long := w >= d
	var L := w if long else d
	var D := d if long else w
	var ax := func(along: float, across: float, y: float) -> Vector3:
		return Vector3(along, y, across) if long else Vector3(across, y, along)
	var sz := func(along: float, y: float, across: float) -> Vector3:
		return Vector3(along, y, across) if long else Vector3(across, y, along)
	_bm("edge", Vector3(0, 0.736, 0), sz.call(L, 0.028, D))
	_bm("laminate", Vector3(0, 0.751, 0), sz.call(L - 0.012, 0.004, D - 0.012))
	var n := maxi(2, ceili(L / 1.8) + 1)
	for i in n:
		var at: float = -L / 2 + 0.08 + (L - 0.16) * i / float(n - 1)
		for s in [-1.0, 1.0]:
			_bm("desk_frame", ax.call(at, s * (D / 2 - 0.07), 0.36), Vector3(0.045, 0.72, 0.045))
		_bm("desk_frame", ax.call(at, 0.0, 0.02), sz.call(0.045, 0.03, D - 0.1))
	for s in [-1.0, 1.0]:
		_bm("desk_frame", ax.call(0.0, s * (D / 2 - 0.07), 0.69), sz.call(L - 0.12, 0.06, 0.025))


## Round table: top on a pedestal column with a cross foot.
func _round_table(w: float, d: float) -> void:
	_bm("edge", Vector3(0, 0.736, 0), Vector3(w, 0.028, d), "cyl")
	_bm("laminate", Vector3(0, 0.751, 0), Vector3(w - 0.014, 0.004, d - 0.014), "cyl")
	_tube("chrome", Vector3(0, 0.03, 0), Vector3(0, 0.72, 0), 0.04)
	var f := minf(w, d) * 0.62
	_bm("shell_dark", Vector3(0, 0.02, 0), Vector3(f, 0.03, 0.07))
	_bm("shell_dark", Vector3(0, 0.02, 0), Vector3(0.07, 0.03, f))


## Office desk: top with an edge band on steel end frames, a modesty panel on the far side and a drawer pedestal.
func _desk(w: float, d: float) -> void:
	_bm("edge", Vector3(0, 0.735, 0), Vector3(w, 0.03, d))
	_bm("desk_top", Vector3(0, 0.752, 0), Vector3(w - 0.012, 0.004, d - 0.012))
	for sx in [-1.0, 1.0]:
		var x: float = sx * (w / 2 - 0.05)
		for sz in [-1.0, 1.0]:
			_bm("desk_frame", Vector3(x, 0.36, sz * (d / 2 - 0.06)), Vector3(0.05, 0.72, 0.05))
		_bm("desk_frame", Vector3(x, 0.025, 0), Vector3(0.05, 0.05, d - 0.06))
		_bm("desk_frame", Vector3(x, 0.7, 0), Vector3(0.05, 0.04, d - 0.08))
	_bm("partition", Vector3(0, 0.48, d / 2 - 0.05), Vector3(w - 0.14, 0.36, 0.018))
	if w >= 1.1:
		var px := w / 2 - 0.3
		_bm("laminate", Vector3(px, 0.33, 0.02), Vector3(0.4, 0.6, d * 0.72))
		for k in 3:
			var y: float = 0.13 + k * 0.19
			_bm("edge", Vector3(px, y + 0.09, -d * 0.36 + 0.02 - 0.001), Vector3(0.38, 0.004, 0.004))
			_bm("chrome", Vector3(px, y + 0.03, -d * 0.36 + 0.005), Vector3(0.12, 0.012, 0.012))


## A potted plant: a planter with a soil top and a fan of long leaves arching out (a seeded spread, so every plant
## is a little different but the same on every load).
func _plant(w: float, d: float, h: float) -> void:
	var pr := clampf(minf(w, d) * 0.5, 0.14, 0.3)
	var ph := clampf(pr * 1.6, 0.25, 0.5)
	_bm("planter", Vector3(0, ph / 2, 0), Vector3(pr * 2, ph, pr * 2), "cyl")
	_bm("soil", Vector3(0, ph - 0.01, 0), Vector3(pr * 1.8, 0.02, pr * 1.8), "cyl")
	var rng := RandomNumberGenerator.new()
	rng.seed = int(absf(_ir.origin.x * 73.0 + _ir.origin.z * 131.0))
	var tall := minf(maxf(0.6, minf(w, d) * 2.4), h - ph - 0.1)
	for i in 14:
		var a := TAU * i / 14.0 + rng.randf_range(-0.2, 0.2)
		var lean := rng.randf_range(0.15, 0.55)
		var len := tall * rng.randf_range(0.55, 1.0)
		var b := Basis(Vector3.UP, a) * Basis(Vector3.RIGHT, lean) * Basis.from_scale(Vector3(rng.randf_range(0.05, 0.08), len, 0.012))
		var base := Vector3(0, ph, 0)
		var mid := base + (Basis(Vector3.UP, a) * Basis(Vector3.RIGHT, lean)) * Vector3(0, len / 2, 0)
		_emit("box", "leaf" if i % 3 else "leaf_dark", _ir * Transform3D(b, mid))


## Treadmill: running deck with side rails on a motor hood, two uprights to a console with handlebars.
func _treadmill(w: float, d: float) -> void:
	var tw := minf(w, 0.9)
	var td := d
	_soft("dark", Vector3(0, 0.1, 0), Vector3(tw, 0.14, td), 0.0, 0.03)
	_bm("belt", Vector3(0, 0.18, -0.04), Vector3(tw * 0.72, 0.02, td * 0.86))
	for sx in [-1.0, 1.0]:
		_bm("steel", Vector3(sx * (tw / 2 - 0.05), 0.185, -0.04), Vector3(0.08, 0.025, td * 0.86))
		_tube("shell_dark", Vector3(sx * (tw / 2 - 0.06), 0.17, td / 2 - 0.12), Vector3(sx * (tw / 2 - 0.09), 1.2, td / 2 - 0.18), 0.03)
		_tube("steel", Vector3(sx * (tw / 2 - 0.08), 1.02, td / 2 - 0.2), Vector3(sx * (tw / 2 - 0.08), 1.02, td / 2 - 0.55), 0.016)
	_soft("shell_dark", Vector3(0, 0.12, td / 2 - 0.1), Vector3(tw, 0.2, 0.2), 0.0, 0.05)
	_soft("shell_dark", Vector3(0, 1.25, td / 2 - 0.2), Vector3(tw * 0.85, 0.12, 0.22), 0.5, 0.03)
	_bm("console", Vector3(0, 1.28, td / 2 - 0.25), Vector3(tw * 0.45, 0.004, 0.12))


## Exercise bike: a heavy frame on two feet, a flywheel under a cover, saddle and handlebars on posts, pedals.
func _bike(w: float, d: float) -> void:
	var L := maxf(d, 0.9)
	for z in [-L / 2 + 0.08, L / 2 - 0.08]:
		_soft("shell_dark", Vector3(0, 0.03, z), Vector3(0.55, 0.05, 0.08), 0.0, 0.02)
	_tube("shell_dark", Vector3(0, 0.05, -L / 2 + 0.1), Vector3(0, 0.45, 0.0), 0.04)
	_tube("shell_dark", Vector3(0, 0.05, L / 2 - 0.1), Vector3(0, 0.45, 0.0), 0.04)
	_emit("cyl", "steel", _ir * Transform3D(Basis(Vector3.FORWARD, PI / 2) * Basis.from_scale(Vector3(0.5, 0.06, 0.5)), Vector3(0, 0.38, 0.22)))
	_soft("shell_dark", Vector3(0, 0.4, 0.22), Vector3(0.09, 0.42, 0.42), 0.0, 0.08)
	_tube("steel", Vector3(0, 0.45, -0.05), Vector3(0, 0.88, -0.2), 0.025)
	_soft("rubber", Vector3(0, 0.92, -0.22), Vector3(0.18, 0.06, 0.26), 0.0, 0.03)
	_tube("steel", Vector3(0, 0.45, 0.2), Vector3(0, 1.08, 0.34), 0.025)
	_tube("rubber", Vector3(-0.24, 1.1, 0.36), Vector3(0.24, 1.1, 0.36), 0.018)
	for sx in [-1.0, 1.0]:
		_tube("steel", Vector3(sx * 0.07, 0.3, 0.05), Vector3(sx * 0.1, 0.22, 0.05), 0.012)
		_bm("rubber", Vector3(sx * 0.14, 0.22, 0.05), Vector3(0.09, 0.02, 0.05))


## Dumbbell rack: a two-tier steel rack with pairs of hex dumbbells, heaviest at the bottom.
func _dumbbell_rack(w: float, d: float) -> void:
	for sx in [-1.0, 1.0]:
		_bm("shell_dark", Vector3(sx * (w / 2 - 0.03), 0.35, 0), Vector3(0.05, 0.7, d * 0.9))
	for t in 2:
		var y := 0.32 + t * 0.32
		var z := -0.08 + t * 0.12
		_bm("steel", Vector3(0, y, z), Vector3(w - 0.06, 0.03, d * 0.5), "box")
		var n := maxi(3, int(w / 0.25))
		for i in n:
			var x := -w / 2 + 0.1 + (w - 0.2) * (i + 0.5) / n
			var r := 0.075 - t * 0.02 - i * 0.002
			for side in [-1.0, 1.0]:
				_emit("cyl", "rubber", _ir * Transform3D(Basis(Vector3.RIGHT, PI / 2) * Basis.from_scale(Vector3(r * 2, 0.05, r * 2)), Vector3(x + side * 0.055, y + r + 0.015, z)))
			_tube("chrome", Vector3(x - 0.07, y + r + 0.015, z), Vector3(x + 0.07, y + r + 0.015, z), 0.014)


## Bar stool: a round padded seat on a chrome post with a foot ring and a weighted base.
func _stool(w: float) -> void:
	var r := clampf(w * 0.5, 0.17, 0.22)
	_bm("chrome", Vector3(0, 0.012, 0), Vector3(r * 2, 0.024, r * 2), "cyl")
	_tube("chrome", Vector3(0, 0.02, 0), Vector3(0, 0.62, 0), 0.025)
	_emit("cyl", "chrome", _ir * Transform3D(Basis.from_scale(Vector3(r * 1.6, 0.02, r * 1.6)), Vector3(0, 0.3, 0)))
	_bm("shell_dark", Vector3(0, 0.64, 0), Vector3(r * 2, 0.03, r * 2), "cyl")
	_soft("seat_grey", Vector3(0, 0.675, 0), Vector3(r * 1.9, 0.06, r * 1.9), 0.0, 0.03)


## Counter: base cupboards with doors and handles on a recessed plinth, a stone top overhanging the front.
func _counter(w: float, d: float) -> void:
	_bm("dark", Vector3(0, 0.05, -0.03), Vector3(w - 0.02, 0.1, d - 0.08))
	_bm("cabinet_grey", Vector3(0, 0.47, 0), Vector3(w, 0.74, d - 0.02))
	var n := maxi(1, roundi(w / 0.6))
	for i in n:
		var x := -w / 2 + w * (i + 0.5) / n
		_bm("white", Vector3(x, 0.47, d / 2 - 0.005), Vector3(w / n - 0.012, 0.72, 0.018))
		_bm("chrome", Vector3(x + w / n * 0.35, 0.72, d / 2 + 0.012), Vector3(0.012, 0.012, 0.012))
		_bm("chrome", Vector3(x + w / n * 0.35, 0.62, d / 2 + 0.02), Vector3(0.012, 0.22, 0.012))
	_bm("stone", Vector3(0, 0.865, 0.01), Vector3(w + 0.02, 0.04, d + 0.04))


## Wash basin(s): a stone vanity with sunk white basins, mixer taps, a mirror and its light above (a narrow
## counter-depth sink is a kitchen or laundry sink: no mirror).
func _basin(w: float, d: float) -> void:
	var n := maxi(1, roundi(w / 0.7))
	var top := 0.84
	_bm("stone", Vector3(0, top, 0), Vector3(w, 0.04, d))
	_bm("cabinet_grey", Vector3(0, top - 0.12, 0), Vector3(w, 0.2, d - 0.04))
	for i in n:
		var x := -w / 2 + w * (i + 0.5) / n
		_bm("porcelain", Vector3(x, top + 0.005, 0.02), Vector3(minf(0.46, w / n - 0.12), 0.012, d * 0.62), "cyl")
		_bm("dark", Vector3(x, top + 0.008, 0.02), Vector3(0.04, 0.008, 0.04), "cyl")
		_tube("chrome", Vector3(x, top, -d / 2 + 0.08), Vector3(x, top + 0.2, -d / 2 + 0.08), 0.016)
		_tube("chrome", Vector3(x, top + 0.2, -d / 2 + 0.08), Vector3(x, top + 0.18, -d / 2 + 0.2), 0.012)
	if d < 0.65:
		_bm("mirror", Vector3(0, 1.45, -d / 2 + 0.01), Vector3(w - 0.06, 0.8, 0.012))
		_bm("frame", Vector3(0, 1.45, -d / 2 + 0.003), Vector3(w - 0.02, 0.84, 0.01))
		_bm("frosted", Vector3(0, 1.9, -d / 2 + 0.05), Vector3(w * 0.6, 0.04, 0.06))


## WC cubicle: partitions with a door gap, a white pan and cistern, a seat, a flush plate and a roll holder.
func _wc(w: float, d: float, h: float) -> void:
	var ph := minf(1.9, h - 0.05)
	for sx in [-1.0, 1.0]:
		_bm("partition2", Vector3(sx * 0.6, 0.12 + ph / 2, 0.15), Vector3(0.03, ph, 1.35))
	_soft("porcelain", Vector3(0, 0.2, 0.05), Vector3(0.36, 0.38, 0.52), 0.0, 0.1)
	_soft("white", Vector3(0, 0.405, 0.06), Vector3(0.38, 0.03, 0.46), 0.0, 0.08)
	_soft("porcelain", Vector3(0, 0.62, -0.25), Vector3(0.42, 0.42, 0.18), 0.0, 0.04)
	_bm("chrome", Vector3(0, 0.8, -0.155), Vector3(0.16, 0.1, 0.008))
	_bm("chrome", Vector3(0.45, 0.7, 0.05), Vector3(0.12, 0.03, 0.08))
	_bm("white", Vector3(0.45, 0.66, 0.05), Vector3(0.1, 0.1, 0.1), "cyl")


## Storage cabinet: a carcass on a plinth, two doors with a centre seam and bar handles, a top (cut at the wall
## height on the map).
func _cabinet(w: float, d: float, h: float) -> void:
	var ch := minf(h - 0.05, 1.9 if w < 1.2 else 0.9)
	_bm("dark", Vector3(0, 0.04, -0.02), Vector3(w - 0.03, 0.08, d - 0.05))
	_bm("cabinet_grey", Vector3(0, 0.08 + (ch - 0.08) / 2, 0), Vector3(w, ch - 0.08, d))
	var n := maxi(2, roundi(w / 0.5))
	for i in n:
		var x := -w / 2 + w * (i + 0.5) / n
		_bm("white", Vector3(x, 0.08 + (ch - 0.08) / 2, d / 2 - 0.004), Vector3(w / n - 0.008, ch - 0.1, 0.016))
		var hx := x + (w / n * 0.4 if i % 2 == 0 else -w / n * 0.4)
		_bm("chrome", Vector3(hx, minf(1.05, ch * 0.55), d / 2 + 0.02), Vector3(0.014, 0.2, 0.014))


## Steel shelving: four uprights, shelves, kraft boxes and binders on them.
func _shelving(w: float, d: float, h: float) -> void:
	var sh := minf(h - 0.1, 2.0)
	var run := maxf(w, d)
	var deep := minf(w, d)
	var along_x := w >= d
	var P := func(a: float, y: float, c: float) -> Vector3:
		return Vector3(a, y, c) if along_x else Vector3(c, y, a)
	var S := func(a: float, y: float, c: float) -> Vector3:
		return Vector3(a, y, c) if along_x else Vector3(c, y, a)
	for sa in [-1.0, 1.0]:
		for sc in [-1.0, 1.0]:
			_bm("steel", P.call(sa * (run / 2 - 0.02), sh / 2, sc * (deep / 2 - 0.02)), Vector3(0.035, sh, 0.035))
	var levels := maxi(2, int(sh / 0.42))
	var rng := RandomNumberGenerator.new()
	rng.seed = int(absf(_ir.origin.x * 37.0 + _ir.origin.z * 91.0))
	for k in levels:
		var y := 0.08 + k * (sh - 0.1) / (levels - 1)
		_bm("steel", P.call(0, y, 0), S.call(run - 0.02, 0.02, deep - 0.02))
		if k == levels - 1:
			break
		var x := -run / 2 + 0.06
		while x < run / 2 - 0.2:
			var bw := rng.randf_range(0.22, 0.4)
			var bh := rng.randf_range(0.18, 0.3)
			_soft("box_kraft" if rng.randf() < 0.7 else "white", P.call(x + bw / 2, y + 0.01 + bh / 2, 0), S.call(bw - 0.02, bh, deep * 0.8), 0.0, 0.01)
			x += bw + rng.randf_range(0.02, 0.08)


## Bed: a frame with legs, mattress, a duvet folded back at the head, pillows and a headboard.
func _bed(w: float, d: float) -> void:
	var long_z := d >= w
	var L := d if long_z else w
	var B := w if long_z else d
	var P := func(a: float, y: float, c: float) -> Vector3:
		return Vector3(c, y, a) if long_z else Vector3(a, y, c)
	var S := func(a: float, y: float, c: float) -> Vector3:
		return Vector3(c, y, a) if long_z else Vector3(a, y, c)
	_bm("wood_dark", P.call(0, 0.2, 0), S.call(L, 0.16, B))
	_soft("linen", P.call(0, 0.38, 0), S.call(L - 0.04, 0.2, B - 0.04), 0.0, 0.06)
	_soft("duvet", P.call(0.15, 0.5, 0), S.call(L - 0.35, 0.06, B + 0.02), 0.0, 0.03)
	_bm("wood_dark", P.call(-L / 2 + 0.03, 0.55, 0), S.call(0.06, 0.7, B + 0.04))
	for sc in [-1.0, 1.0]:
		_soft("white", P.call(-L / 2 + 0.25, 0.53, sc * B * 0.24 if B > 1.2 else 0.0), S.call(0.3, 0.12, minf(0.6, B * 0.42)), 0.0, 0.05)
		if B <= 1.2:
			break


## Sofa or armchair: upholstered base, arms, separate seat and back cushions, short dark legs.
func _sofa(w: float, d: float, seats: int) -> void:
	var arm := clampf(w * 0.09, 0.14, 0.2)
	_soft("sofa", Vector3(0, 0.22, 0.02), Vector3(w, 0.2, d - 0.04))
	_soft("sofa", Vector3(0, 0.47, -d / 2 + 0.1), Vector3(w, 0.62, 0.2), -0.04)
	for sx in [-1.0, 1.0]:
		_soft("sofa", Vector3(sx * (w / 2 - arm / 2), 0.4, 0.02), Vector3(arm, 0.42, d - 0.04))
		for sz in [-1.0, 1.0]:
			_bm("wood_dark", Vector3(sx * (w / 2 - 0.06), 0.05, sz * (d / 2 - 0.08)), Vector3(0.045, 0.1, 0.045), "cyl")
	var inner := w - 2 * arm
	var cw := inner / seats
	for i in seats:
		var x: float = -inner / 2 + cw * (i + 0.5)
		_soft("cushion", Vector3(x, 0.395, 0.06), Vector3(cw - 0.012, 0.15, d - 0.3))
		_soft("cushion", Vector3(x, 0.66, -d / 2 + 0.24), Vector3(cw - 0.02, 0.42, 0.17), -0.16)


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
			# a finished structural column: painted plaster on all four faces, a skirting band at the floor like the
			# walls', brushed-steel corner guards to waist height (they take the knocks), a shadow gap at the ceiling
			_bm("col_paint", Vector3(0, h / 2, 0), Vector3(w, h, d))
			_bm("col_skirt", Vector3(0, 0.05, 0), Vector3(w + 0.024, 0.1, d + 0.024))
			# the map view cuts walls (and columns with them) low: the ceiling gap and guards belong to full height only
			if h > 2.0:
				_bm("col_gap", Vector3(0, h - 0.025, 0), Vector3(w - 0.02, 0.05, d - 0.02))
				for sx in [-1.0, 1.0]:
					for sz in [-1.0, 1.0]:
						_bm("col_guard", Vector3(sx * (w / 2 - 0.016), 0.75, sz * (d / 2 - 0.016)), Vector3(0.05, 1.3, 0.05))
		"chair":
			_stack_chair(w, d)
		"task_chair":
			_task_chair(w, d, "seat_grey")
		"table":
			_table(w, d)
		"round_table":
			_round_table(w, d)
		"desk":
			_desk(w, d)
			var seats := maxi(1, roundi(w / 0.66))
			for i in seats:
				_setup(-w / 2 + w * (i + 0.5) / seats, d)
		"desk_one", "desk_plain":
			# the SmartThings zone's L-desk (photos): maple top on chrome legs, one monitor and keyboard on the main
			# desk, nothing on the return
			_swap = {"wood": "maple", "metal": "chrome"}
			_model("desk", Vector3.ZERO, w, d, 0.75, PI)
			_swap = {}
			if kind == "desk_one":
				_setup(w * 0.22, d)
		"desk_flowers":
			# white flower bouquets in white fluted pots, standing on the desk (the zone's desk return)
			var top := 0.755
			var rng := RandomNumberGenerator.new()
			rng.seed = 41
			for k in 3:
				var px := (k - 1) * w * 0.36
				var pz := (0.03 if k == 1 else -0.03)
				_bm("gloss_white", Vector3(px, top + 0.07, pz), Vector3(0.12, 0.14, 0.12), "cyl")
				for j in 5:
					var a := TAU * j / 5.0 + k
					_bm("leaf", Vector3(px + cos(a) * 0.035, top + 0.22, pz + sin(a) * 0.035), Vector3(0.012, 0.18, 0.012))
				for j in 9:
					var off := Vector3(rng.randf_range(-0.09, 0.09), rng.randf_range(0.27, 0.4), rng.randf_range(-0.07, 0.07))
					_bm("porcelain" if j % 3 == 0 else "white", Vector3(px, top, pz) + off, Vector3(0.06, 0.05, 0.06), "sphere")
		"mesh_chair":
			# black mesh office chair with a headrest (the zone's chairs)
			_swap = {"carpet": "mesh_black", "fabric": "mesh_black", "metalMedium": "dark"}
			_model("chairDesk", Vector3.ZERO, w, d)
			_swap = {}
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
			_sofa(w, d, 1 if kind == "armchair" or w < 1.2 else (3 if w > 1.7 else 2))
		"bed":
			_bed(w, d)
		"cabinet":
			_cabinet(w, d, h)
		"shelf":
			_shelving(w, d, h)
		"rack":
			_b("dark", Vector3(0, minf(h, 1.1) / 2, 0), Vector3(1, minf(h, 1.1), 1))
			for y in [0.3, 0.55, 0.8]:
				_b("led", Vector3(0, y, 0.51), Vector3(0.6, 0.03, 0.02))
		"counter":
			_counter(w, d)
		"sink":
			_basin(w, d)
		"toilet":
			_wc(w, d, h)
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
			_treadmill(w, d)
		"bike":
			_bike(w, d)
		"weight_rack":
			_dumbbell_rack(w, d)
		"locker":
			# a bank of steel lockers (cut at the wall height like the walls), a door per 0.4 m with vents and a handle
			var lh := minf(h, 1.1)
			_b("locker", Vector3(0, lh / 2, 0), Vector3(1, lh, 1))
			var n := maxi(2, roundi(w / 0.4))
			for i in n:
				var x := -w / 2 + w * (i + 0.5) / n
				_bm("partition2", Vector3(x, lh / 2, d / 2 + 0.006), Vector3(w / n - 0.02, lh - 0.05, 0.012))
				_bm("chrome", Vector3(x + w / n * 0.32, lh * 0.55, d / 2 + 0.016), Vector3(0.02, 0.1, 0.012))
				for v in 3:
					_bm("dark", Vector3(x, lh - 0.1 - v * 0.035, d / 2 + 0.014), Vector3(w / n * 0.5, 0.012, 0.006))
		"bench":
			_bm("wood", Vector3(0, 0.44, 0), Vector3(w, 0.05, d))
			for sx in [-1, 1]:
				_bm("frame", Vector3(sx * (w / 2 - 0.06), 0.21, 0), Vector3(0.04, 0.42, d * 0.85))
		"stool":
			_stool(w)
		"dispenser":
			# water dispenser: cabinet, taps, a blue bottle upside down on top
			_bm("white", Vector3(0, 0.5, 0), Vector3(w, 1.0, d))
			_bm("dark", Vector3(0, 0.72, d / 2 + 0.01), Vector3(w * 0.7, 0.18, 0.02))
			_bm("rail", Vector3(-w * 0.15, 0.7, d / 2 + 0.04), Vector3(0.03, 0.05, 0.05))
			_bm("console", Vector3(w * 0.15, 0.7, d / 2 + 0.04), Vector3(0.03, 0.05, 0.05))
			_bm("water", Vector3(0, 1.17, 0), Vector3(w * 0.8, 0.34, w * 0.8), "cyl")
		"vending":
			# drinks fridges: dark cabinets with lit glass fronts and shelves of cans (cut at the wall height)
			var vh := minf(h, 1.1)
			var units := maxi(1, roundi(w / 0.6))
			for i in units:
				var x := -w / 2 + w * (i + 0.5) / units
				var uw := w / units - 0.03
				_bm("dark", Vector3(x, vh / 2, 0), Vector3(uw, vh, d))
				_bm("glass", Vector3(x, vh / 2 + 0.05, d / 2 + 0.005), Vector3(uw * 0.86, vh - 0.25, 0.01))
				for sh in 4:
					var y := 0.25 + sh * (vh - 0.35) / 4.0
					_bm("frame", Vector3(x, y, d * 0.1), Vector3(uw * 0.84, 0.012, d * 0.7))
					_bm("drinks", Vector3(x, y + 0.06, d * 0.1), Vector3(uw * 0.78, 0.1, d * 0.5))
				_bm("console", Vector3(x, vh - 0.07, d / 2 + 0.008), Vector3(uw * 0.8, 0.06, 0.01))
		"shower":
			# shower cubicle: tray, tiled back wall, side panels, glass door, mixer and head
			_b("porcelain", Vector3(0, 0.04, 0), Vector3(1, 0.08, 1))
			_bm("tile", Vector3(0, 0.6, -d / 2 + 0.02), Vector3(w, 1.1, 0.04))
			for sx in [-1, 1]:
				_bm("partition2", Vector3(sx * w / 2, 0.6, 0), Vector3(0.03, 1.1, d))
			_bm("glass", Vector3(-w * 0.12, 0.6, d / 2), Vector3(w * 0.74, 1.05, 0.015))
			_bm("chrome", Vector3(w * 0.25, 0.6, d / 2), Vector3(0.02, 1.05, 0.02))
			_bm("chrome", Vector3(0, 1.0, -d / 2 + 0.1), Vector3(0.025, 0.025, 0.16))
			_bm("chrome", Vector3(0, 0.98, -d / 2 + 0.17), Vector3(0.14, 0.015, 0.14), "cyl")
			_bm("chrome", Vector3(0, 0.75, -d / 2 + 0.05), Vector3(0.1, 0.06, 0.04))
			_bm("dark", Vector3(0, 0.085, 0), Vector3(0.07, 0.01, 0.07), "cyl")  # drain
		"elec_panel":
			# electrical distribution board: grey cabinet, door seam, status lights, warning label
			var ph := minf(h, 1.1)
			_b("partition2", Vector3(0, ph / 2, 0), Vector3(1, ph, 1))
			_bm("frame", Vector3(0, ph / 2, d / 2 + 0.004), Vector3(0.01, ph - 0.08, 0.008))
			_bm("warn", Vector3(-w * 0.22, ph * 0.72, d / 2 + 0.006), Vector3(minf(0.12, w * 0.3), 0.08, 0.006))
			for k in 3:
				_bm("led" if k < 2 else "rail", Vector3(w * 0.12 + k * 0.05, ph * 0.86, d / 2 + 0.008), Vector3(0.025, 0.025, 0.008), "cyl")
			_bm("chrome", Vector3(w * 0.06, ph * 0.5, d / 2 + 0.012), Vector3(0.02, 0.09, 0.015))
		"tufted_sofa":
			# grey velvet two-seater: rounded back and arms, buttoned back, two cushions, slim dark legs
			var sh := 0.42
			_bm("velvet", Vector3(0, 0.28, 0.02), Vector3(w * 0.86, 0.2, d * 0.78))
			_bm("velvet", Vector3(0, 0.6, -d * 0.36), Vector3(w * 0.98, 0.5, d * 0.24), "cyl" if false else "box")
			for sx in [-1, 1]:
				_bm("velvet", Vector3(sx * w * 0.45, 0.43, 0), Vector3(w * 0.1, 0.42, d * 0.95))
				_bm("velvet_dark", Vector3(sx * w * 0.22, sh + 0.16, -d * 0.2), Vector3(0.42, 0.36, 0.12))
				for lz in [-1, 1]:
					_bm("dark", Vector3(sx * w * 0.42, 0.06, lz * d * 0.38), Vector3(0.03, 0.12, 0.03), "cyl")
			for i in 7:
				for j in 2:
					_bm("velvet_dark", Vector3(-w * 0.42 + i * w * 0.14, 0.52 + j * 0.16, -d * 0.235), Vector3(0.025, 0.025, 0.012), "sphere")
		"tv_unit":
			# walnut TV unit: open shelves in the middle, drawers either side, on splayed legs
			_bm("walnut", Vector3(0, 0.56, 0), Vector3(w, 0.035, d))
			_bm("walnut", Vector3(0, 0.12, 0), Vector3(w * 0.96, 0.03, d * 0.92))
			_bm("walnut", Vector3(0, 0.32, -d * 0.1), Vector3(w * 0.5, 0.025, d * 0.7))
			for sx in [-1, 1]:
				_bm("walnut", Vector3(sx * w * 0.36, 0.34, 0), Vector3(w * 0.27, 0.42, d * 0.92))
				_bm("dark", Vector3(sx * w * 0.36, 0.34, d * 0.465), Vector3(w * 0.12, 0.012, 0.01))
				_bm("walnut", Vector3(sx * w * 0.24, 0.05, d * 0.35), Vector3(0.04, 0.1, 0.04))
				_bm("walnut", Vector3(sx * w * 0.24, 0.05, -d * 0.35), Vector3(0.04, 0.1, 0.04))
		"coffee_table":
			_bm("walnut", Vector3(0, 0.43, 0), Vector3(w, 0.04, d))
			_bm("walnut", Vector3(0, 0.12, d * 0.05), Vector3(w * 0.9, 0.03, d * 0.8))
			for sx in [-1, 1]:
				_bm("walnut", Vector3(sx * w * 0.46, 0.22, 0), Vector3(0.05, 0.42, d * 0.95))
			_bm("dark", Vector3(w * 0.15, 0.46, -d * 0.1), Vector3(0.05, 0.015, 0.17))  # the TV remote
		"floor_lamp":
			# brass pole on a round base, black drum shade lit gold inside (lower on the cut-away map)
			var top := minf(1.55, h - 0.22)
			_bm("brass", Vector3(0, 0.012, 0), Vector3(0.36, 0.024, 0.36), "cyl")
			_bm("brass", Vector3(0, top / 2, 0), Vector3(0.025, top, 0.025), "cyl")
			_bm("frosted", Vector3(0, top * 0.7, 0), Vector3(0.06, 0.18, 0.06), "cyl")
			_bm("shade", Vector3(0, top, 0), Vector3(0.5, 0.3, 0.5), "cyl")
			# gold lining, unlit: a smart bulb in the lamp (DeviceFx "lamp") lights it only while it is on
			_bm("shade_inner", Vector3(0, top - 0.01, 0), Vector3(0.46, 0.29, 0.46), "cyl")
		"bookcase_white":
			# white bookcase: closed cupboard below, open shelves above with red and white books
			var bh := minf(h - 0.15, 1.95)
			_bm("gloss_white", Vector3(0, 0.36, 0), Vector3(w, 0.72, d))
			for sx in [-0.25, 0.25]:
				_bm("chrome", Vector3(sx * w * 0.2, 0.5, d / 2 + 0.01), Vector3(0.015, 0.12, 0.015))
			_bm("gloss_white", Vector3(0, bh - 0.015, 0), Vector3(w, 0.03, d))
			for sx in [-1, 0, 1]:
				_bm("gloss_white", Vector3(sx * (w / 2 - 0.015), (bh + 0.72) / 2, 0), Vector3(0.03, bh - 0.72, d))
			for k in 3:
				var y := 0.72 + (k + 1) * (bh - 0.72) / 3.0
				_bm("gloss_white", Vector3(0, y - 0.015, 0), Vector3(w, 0.025, d))
			for k in 3:
				var y0 := 0.74 + k * (bh - 0.72) / 3.0
				for b in 5:
					var red := (b + k) % 3 != 0
					_bm("book_red" if red else "white", Vector3(-w * 0.4 + b * 0.05 + (0.5 * w if k == 1 else 0.0), y0 + 0.12, -d * 0.05), Vector3(0.035, 0.24, d * 0.7))
			_bm("dark", Vector3(w * 0.22, 0.74 + 2 * (bh - 0.72) / 3.0 + 0.03, 0), Vector3(0.3, 0.04, 0.18))  # the router
		"poster":
			# framed print at eye height on the wall it faces away from
			_bm("white", Vector3(0, 1.55, 0), Vector3(w, w * 1.3, 0.025))
			_bm("poster", Vector3(0, 1.62, 0.014), Vector3(w * 0.8, w * 0.55, 0.005))
			_bm("dark", Vector3(-w * 0.1, 1.3, 0.014), Vector3(w * 0.5, w * 0.25, 0.005))
		"lift_door":
			# a lift on the lobby wall: stainless frame and doors with the centre seam, call buttons beside it;
			# the panelled ones (the other wall) are dressed with light blue box frames on dark steel
			var dh := minf(h - 0.25, 2.05)
			var panel: bool = _cur.get("panel", false)
			var arriving: bool = _cur.get("arrival", false)
			for sx in [-1, 1]:  # frame: jambs and head
				_bm("chrome", Vector3(sx * (w / 2 + 0.035), dh / 2, 0.02), Vector3(0.07, dh + 0.04, 0.06))
			_bm("chrome", Vector3(0, dh + 0.02, 0.02), Vector3(w + 0.14, 0.06, 0.06))
			if not arriving:
				_bm("dark" if panel else "steel_door", Vector3(0, dh / 2, 0.035), Vector3(w, dh, 0.02))
			if panel:
				var boxes := [[-0.25, 0.25, 0.4, 0.35], [0.1, 0.42, 0.3, 0.32], [0.33, 0.62, 0.2, 0.55], [-0.3, 1.0, 0.3, 0.5], [0.05, 0.9, 0.35, 0.22],
						[0.3, 1.25, 0.25, 0.3], [-0.22, 1.55, 0.45, 0.3], [0.2, 1.65, 0.4, 0.45], [-0.3, 1.95, 0.3, 0.3], [0.1, 2.0, 0.25, 0.2]]
				for b in boxes:
					if float(b[1]) + float(b[3]) / 2 > dh:
						continue
					var bx: float = float(b[0]) * w
					var bw: float = float(b[2]) * w
					for e in [[Vector3(bx - bw / 2, b[1], 0.05), Vector3(0.03, b[3], 0.04)], [Vector3(bx + bw / 2, b[1], 0.05), Vector3(0.03, b[3], 0.04)],
							[Vector3(bx, float(b[1]) - float(b[3]) / 2, 0.05), Vector3(bw, 0.03, 0.04)], [Vector3(bx, float(b[1]) + float(b[3]) / 2, 0.05), Vector3(bw, 0.03, 0.04)]]:
						_bm("box_blue", e[0], e[1])
			elif not arriving:
				_bm("dark", Vector3(0, dh / 2, 0.047), Vector3(0.008, dh - 0.02, 0.004))
			# call panel with two buttons and a floor display
			_bm("chrome", Vector3(w / 2 + 0.55, 1.2, 0.035), Vector3(0.1, 0.38, 0.02))
			_bm("monitor", Vector3(w / 2 + 0.55, 1.32, 0.047), Vector3(0.06, 0.08, 0.004))
			_bm("led", Vector3(w / 2 + 0.55, 1.15, 0.047), Vector3(0.025, 0.025, 0.006), "cyl")
			_bm("led", Vector3(w / 2 + 0.55, 1.08, 0.047), Vector3(0.025, 0.025, 0.006), "cyl")
		"lift_shaft":
			# a lift shaft behind the lobby wall: a solid concrete block, full height (left open for the arriving car)
			if not _cur.get("arrival", false):
				_bm("concrete", Vector3(0, h / 2, 0), Vector3(w, h, d))
		"exit_sign":
			# green EXIT sign over the glass doors
			var sy := minf(h - 0.2, 2.4)
			_bm("white", Vector3(0, sy + 0.12, 0), Vector3(0.42, 0.06, 0.12))
			_bm("exit_green", Vector3(0, sy, 0.0), Vector3(0.4, 0.16, 0.02))
		"water_bottles":
			# 20-litre water bottles stacked by the doors
			for i in 10:
				var bx := -w / 2 + 0.14 + (i % 5) * (w - 0.28) / 4.0
				var bz := -d / 4 if i < 5 else d / 4
				_bm("bottle", Vector3(bx, 0.25, bz), Vector3(0.27, 0.5, 0.27), "cyl")
				_bm("bottle_cap", Vector3(bx, 0.53, bz), Vector3(0.07, 0.06, 0.07), "cyl")
		"desk_lamp":
			# white desk lamp on the desk: round base, curved neck, head over the desk
			_bm("gloss_white", Vector3(0, 0.765, 0), Vector3(0.16, 0.02, 0.16), "cyl")
			_bm("frosted", Vector3(0, 0.95, -0.02), Vector3(0.03, 0.36, 0.03), "cyl")
			_bm("gloss_white", Vector3(0, 1.15, 0.06), Vector3(0.2, 0.06, 0.12), "sphere")
			_bm("shade_inner", Vector3(0, 1.12, 0.07), Vector3(0.12, 0.01, 0.07))
		"monitor":
			_setup(-w * 0.15, d)
		"plant":
			_plant(w, d, h)
		"door" when _cur.get("opening", false):
			pass  # a plain opening in the wall (the arrival lift); its frame is the lift's own
		"door":
			# frame jambs, one or two leaves standing open 70 degrees towards +z, handle, and the swing drawn on the floor
			var lh := minf(h, 2.05) - 0.02
			# the zone's glass door keeps its aluminium frame; every other door has a painted hardwood frame and head
			var fm := "frame" if _cur.get("glass", false) else "door_frame"
			for sx in [-1, 1]:
				_bm(fm, Vector3(sx * (w / 2 + 0.025), lh / 2, 0), Vector3(0.05, lh, 0.14))
			if fm == "door_frame":
				_bm(fm, Vector3(0, lh + 0.03, 0), Vector3(w + 0.1, 0.06, 0.14))
			var leaves := 2 if w > 1.2 else 1
			var lw := w / leaves
			for li in leaves:
				var side := -1.0 if li == 0 else 1.0  # hinge at -w/2 or +w/2; the leaf reaches towards the middle
				var hinge := Vector3(side * w / 2, 0, 0)
				# open 70° on the map; flat against the wall while walking, so the doorway is clear
				# shut across the opening when its smart lock is locked
				var ang := 0.0 if _cur.get("locked", false) else (92.0 if Store.walk or _cur.get("held_open", false) else 70.0)
				var leaf := Transform3D(Basis(Vector3.UP, deg_to_rad(ang) * side), hinge)
				var glass_door: bool = _cur.get("glass", false)
				_emit("box", "frosted" if glass_door else "door", _ir * leaf * Transform3D(Basis.from_scale(Vector3(lw - 0.02, lh, 0.012 if glass_door else 0.04)), Vector3(-side * lw / 2, lh / 2, 0)))
				if glass_door:  # pull handle and a frosted band
					_emit("box", "chrome", _ir * leaf * Transform3D(Basis.from_scale(Vector3(0.02, 0.5, 0.06)), Vector3(-side * (lw - 0.1), 1.0, 0)))
				_emit("box", "metal", _ir * leaf * Transform3D(Basis.from_scale(Vector3(0.12, 0.025, 0.06)), Vector3(-side * (lw - 0.12), 0.95, 0)))
				for k in 9:  # quarter-circle swing arc on the floor
					var a := deg_to_rad(90.0) * (k + 0.5) / 9.0
					var p := hinge + Vector3(-side * cos(a) * lw, 0.006, sin(a) * lw)
					var seg := Basis(Vector3.UP, side * a) * Basis.from_scale(Vector3(lw * 0.17, 0.004, 0.012))
					_emit("box", "arc", _ir * Transform3D(seg, p))
		_:
			counts[kind] -= 1
			_b("goods", Vector3(0, 0.4, 0), Vector3(1, 0.8, 1))
