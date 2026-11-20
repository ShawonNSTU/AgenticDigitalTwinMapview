class_name FloorBuilder
extends Node3D
## Builds floor slabs, cut-away walls and room labels from res://data/building.json.

const SLAB := 0.08
const WALL := 0.08

var _slabs := {}  # room key -> StandardMaterial3D
var _walls: Array = []
var wall_pieces: Array = []  # [a, b] on the floor for every built wall piece (door gaps left out)
var lintels: Array = []      # [a, b] over each door gap (walk mode only: the walls reach the ceiling)
var _veil: MeshInstance3D
var _veil_tw: Tween
var _plan_mat: StandardMaterial3D


func build() -> void:
	for r in Store.rooms:
		var poly := PlanGeo.room_poly(r)
		var mat := StandardMaterial3D.new()
		mat.albedo_color = Color(r.color).lerp(Color("d9dde3"), 0.55)
		mat.roughness = 0.9
		mat.cull_mode = BaseMaterial3D.CULL_DISABLED
		_finish(mat, str(r.name).to_lower())
		_slabs[r.key] = mat
		_slab(poly, mat)
		_room_label(r, poly)
	for n in Store.notes:
		_note(n)
	var wall_mat := StandardMaterial3D.new()
	wall_mat.albedo_color = Color("f2f3f5")
	wall_mat.roughness = 0.8
	var h: float = Store.wall_height
	# Walls follow every room edge (any angle); shared walls are built once; door openings are left open.
	var doors: Array = Store.furniture.filter(func(f): return f.get("kind", "") == "door")
	for s in PlanGeo.wall_segments(Store.rooms):
		var a: Vector2 = s[0]
		var b: Vector2 = s[1]
		var length := a.distance_to(b)
		var u := (b - a) / length
		var gaps: Array = []
		for dr in doors:
			var p := Vector2(float(dr.x), float(dr.z))
			var t := (p - a).dot(u)
			var across := Vector2(cos(float(dr.get("rot", 0.0))), -sin(float(dr.get("rot", 0.0))))
			if t > 0.0 and t < length and p.distance_to(a + u * t) < 0.25 and absf(across.dot(u)) > 0.9:
				gaps.append([t - float(dr.w) / 2, t + float(dr.w) / 2])
		gaps.sort_custom(func(g1, g2): return g1[0] < g2[0])
		var start := -WALL / 2
		for g in gaps + [[length + WALL / 2, length + WALL / 2]]:
			var end: float = g[0]
			if end - start > 0.02:
				var mid := a + u * ((start + end) / 2)
				var w := _box(Vector3(mid.x, h / 2, mid.y), Vector3(end - start, h, WALL), wall_mat)
				w.rotation.y = -atan2(u.y, u.x)
				_walls.append(w)
				wall_pieces.append([a + u * maxf(start, 0.0), a + u * minf(end, length)])
			if g[1] > g[0] and h > Walker.LINTEL + 0.05:
				# full-height walls (walk mode): the wall closes over the door opening
				var gm: Vector2 = a + u * ((g[0] + g[1]) / 2)
				var lt := _box(Vector3(gm.x, (Walker.LINTEL + h) / 2, gm.y), Vector3(g[1] - g[0], h - Walker.LINTEL, WALL), wall_mat)
				lt.rotation.y = -atan2(u.y, u.x)
				_walls.append(lt)
				lintels.append([a + u * g[0], a + u * g[1]])
			start = maxf(start, g[1])
	if Store.walk:
		_ceilings(h)
	if Store.outdoor_pad.has("x"):
		var pad := StandardMaterial3D.new()
		pad.albedo_color = Color("9aa3ad")
		_box(Vector3(Store.outdoor_pad.x, -0.02, Store.outdoor_pad.z), Vector3(1.6, 0.04, 1.2), pad)
	var ground := StandardMaterial3D.new()
	ground.albedo_color = Color("1a2028")
	var fr: Rect2 = Store.floor_rect()
	_box(Vector3(fr.get_center().x, -SLAB - 0.03, fr.get_center().y), Vector3(fr.size.x + 60, 0.02, fr.size.y + 60), ground)
	if Store.plan_texture:
		# The uploaded plan lies on top of the floor so you can see it turn into the 3D map.
		_plan_mat = StandardMaterial3D.new()
		_plan_mat.albedo_texture = Store.plan_texture
		_plan_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		_plan_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		var pb: Rect2 = Store.plan_bounds
		var plane := MeshInstance3D.new()
		var pm := PlaneMesh.new()
		pm.size = pb.size
		plane.mesh = pm
		plane.material_override = _plan_mat
		plane.position = Vector3(pb.get_center().x, 0.006, pb.get_center().y)
		add_child(plane)


## Floor finish from the room's name: tiles in wet rooms, carpet where people sit or pray, plain screed elsewhere.
static var _tile_tex: Texture2D
static var _carpet_tex: Texture2D

func _finish(mat: StandardMaterial3D, name: String) -> void:
	var wet := ["toilet", "bath", "ablution", "wash", "kitchen", "laundry", "utility", "a/c", "outdoor", "stair"]
	var soft := ["pray", "training", "class", "bed", "maternity", "workspace", "zone d", "media", "living", "office", "experience"]
	for k in wet:
		if name.contains(k):
			if _tile_tex == null:
				var img := Image.create(64, 64, false, Image.FORMAT_RGB8)
				img.fill(Color(1, 1, 1))
				for i in 64:
					for j in [0, 1]:
						img.set_pixel(i, j, Color(0.72, 0.74, 0.77))
						img.set_pixel(j, i, Color(0.72, 0.74, 0.77))
				img.generate_mipmaps()
				_tile_tex = ImageTexture.create_from_image(img)
			mat.albedo_texture = _tile_tex
			mat.uv1_triplanar = true
			mat.uv1_world_triplanar = true
			mat.uv1_scale = Vector3.ONE / 0.6  # 600 mm tiles
			mat.roughness = 0.35
			return
	for k in soft:
		if name.contains(k):
			if _carpet_tex == null:
				var n := FastNoiseLite.new()
				n.frequency = 0.35
				var nt := NoiseTexture2D.new()
				nt.noise = n
				nt.width = 128
				nt.height = 128
				nt.seamless = true
				nt.color_ramp = Gradient.new()
				nt.color_ramp.set_color(0, Color(0.82, 0.82, 0.84))
				nt.color_ramp.set_color(1, Color(1, 1, 1))
				_carpet_tex = nt
			mat.albedo_texture = _carpet_tex
			mat.uv1_triplanar = true
			mat.uv1_world_triplanar = true
			mat.uv1_scale = Vector3.ONE / 1.5
			mat.roughness = 1.0
			return


## While a device twin is open, walls turn to glass so they never hide it.
## Room name as printed on the plan (label/labelAt from the plan when there is one), flat on the floor,
## sized to the room so long names stay inside it, with the zone tag under it.
func _room_label(r: Dictionary, poly: PackedVector2Array) -> void:
	var text: String = str(r.get("label", r.name))
	var at: Vector2
	if r.has("labelAt"):
		at = Vector2(r.labelAt[0], r.labelAt[1])
	else:
		at = PlanGeo.interior_point(poly)
	var box := Rect2(poly[0], Vector2.ZERO)
	for v in poly:
		box = box.expand(v)
	var longest := 1
	for line in text.split("\n"):
		longest = maxi(longest, line.length())
	# about 0.55 em per character; keep the text within ~85 % of the room width, between 0.16 and 0.42 m tall
	var em := clampf(box.size.x * 0.85 / (longest * 0.55), 0.16, 0.32)
	var label := Label3D.new()
	label.text = text
	label.font_size = 64
	label.pixel_size = em / 64.0
	label.modulate = Color(0.13, 0.17, 0.25, 0.9)
	label.outline_size = 12
	label.outline_modulate = Color(1, 1, 1, 0.55)
	label.rotation = Vector3(-PI / 2, 0, 0)
	label.position = Vector3(at.x, 0.014, at.y)
	label.name = "Label_" + str(r.key)
	add_child(label)
	var zone: String = str(r.get("zone", ""))
	if zone != "":
		var tag := Label3D.new()
		tag.text = "ZONE " + zone
		tag.font_size = 64
		tag.pixel_size = em * 0.5 / 64.0
		tag.modulate = Color(0.25, 0.45, 0.75, 0.75)
		tag.rotation = Vector3(-PI / 2, 0, 0)
		tag.position = Vector3(at.x, 0.014, at.y + em * (0.75 * text.split("\n").size() + 0.2))
		add_child(tag)


## Other text printed on the plan: zone tags (on a light-blue band like the sheet), SCREEN, UP/DN, dimensions.
func _note(n: Dictionary) -> void:
	var text: String = str(n.text)
	var size: float = float(n.get("size", 1.0))
	var em := 0.26 * size
	var label := Label3D.new()
	label.text = text
	label.font_size = 64
	label.pixel_size = em / 64.0
	label.rotation = Vector3(-PI / 2, float(n.get("rot", 0.0)), 0)
	label.position = Vector3(n.x, 0.016, n.z)
	var zone := text.begins_with("ZONE")
	label.modulate = Color(0.12, 0.2, 0.35, 0.95) if zone else Color(0.2, 0.24, 0.32, 0.75)
	label.outline_size = 8
	label.outline_modulate = Color(1, 1, 1, 0.5)
	add_child(label)
	if zone:
		var band := MeshInstance3D.new()
		var bm := BoxMesh.new()
		bm.size = Vector3(em * 0.62 * text.length() + em * 1.2, 0.01, em * 1.4)
		band.mesh = bm
		var m := StandardMaterial3D.new()
		m.albedo_color = Color("9fd3ee")
		m.roughness = 0.9
		band.material_override = m
		add_child(band)
		band.position = Vector3(n.x, 0.008, n.z)


func set_walls_faded(on: bool) -> void:
	if _walls.is_empty():
		return
	var m: StandardMaterial3D = _walls[0].material_override
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA if on else BaseMaterial3D.TRANSPARENCY_DISABLED
	m.albedo_color.a = 0.07 if on else 1.0
	# focus mode for an opened twin: labels step back and a dark veil lies over the floor so the twin reads
	for c in get_children():
		if c is Label3D:
			c.visible = not on
	if _veil == null:
		_veil = MeshInstance3D.new()
		var pm := PlaneMesh.new()
		pm.size = Vector2(400, 400)
		_veil.mesh = pm
		var vm := StandardMaterial3D.new()
		vm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		vm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		vm.albedo_color = Color(0.03, 0.05, 0.08, 0.0)
		_veil.material_override = vm
		_veil.position.y = 0.06
		add_child(_veil)
	var veil_mat: StandardMaterial3D = _veil.material_override
	if _veil_tw:
		_veil_tw.kill()
	_veil_tw = create_tween()
	_veil_tw.tween_property(veil_mat, "albedo_color:a", 0.72 if on else 0.0, 0.5)


## Ceilings for the walk-through: one per room at the wall top, facing down, casting no shadow.
func _ceilings(h: float) -> void:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color("e9ebee")
	mat.roughness = 1.0
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	for r in Store.rooms:
		var poly := PlanGeo.room_poly(r)
		var tris := Geometry2D.triangulate_polygon(poly)
		if tris.is_empty():
			continue
		var st := SurfaceTool.new()
		st.begin(Mesh.PRIMITIVE_TRIANGLES)
		st.set_normal(Vector3.DOWN)
		for i in tris:
			st.add_vertex(Vector3(poly[i].x, h, poly[i].y))
		var m := MeshInstance3D.new()
		m.mesh = st.commit()
		m.material_override = mat
		m.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		m.name = "Ceiling_" + str(r.key)
		add_child(m)


## Floor slab for any simple polygon: triangulated top face plus side faces.
func _slab(poly: PackedVector2Array, mat: Material) -> void:
	var tris := Geometry2D.triangulate_polygon(poly)
	if tris.is_empty():
		poly = Geometry2D.convex_hull(poly)  # self-intersecting outline: fall back to its hull
		tris = Geometry2D.triangulate_polygon(poly)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	st.set_normal(Vector3.UP)
	for i in tris:
		st.add_vertex(Vector3(poly[i].x, 0, poly[i].y))
	for k in poly.size():
		var a := poly[k]
		var b := poly[(k + 1) % poly.size()]
		var n := Vector3(b.y - a.y, 0, -(b.x - a.x)).normalized()
		st.set_normal(n)
		for v in [Vector3(a.x, 0, a.y), Vector3(b.x, 0, b.y), Vector3(b.x, -SLAB, b.y), Vector3(a.x, 0, a.y), Vector3(b.x, -SLAB, b.y), Vector3(a.x, -SLAB, a.y)]:
			st.add_vertex(v)
	var m := MeshInstance3D.new()
	m.mesh = st.commit()
	m.material_override = mat
	add_child(m)


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


## Plan to 3D: the plan image fades back, rooms take colour and the walls rise out of the floor.
func play_build_up(secs := 1.6) -> void:
	var tw := create_tween().set_parallel()
	if _plan_mat:
		_plan_mat.albedo_color.a = 1.0
		tw.tween_property(_plan_mat, "albedo_color:a", 0.18, secs * 0.6).set_delay(0.3)
	for r in _slabs:
		var m: StandardMaterial3D = _slabs[r]
		var c := m.albedo_color
		m.albedo_color = Color("eceff3")
		tw.tween_property(m, "albedo_color", c, secs * 0.5).set_delay(secs * 0.2)
	for w in _walls:
		var y: float = w.position.y
		w.position.y = -y
		tw.tween_property(w, "position:y", y, secs * 0.5).set_delay(secs * 0.4).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)


func _box(pos: Vector3, size: Vector3, mat: Material) -> MeshInstance3D:
	var m := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = size
	m.mesh = mesh
	m.material_override = mat
	m.position = pos
	add_child(m)
	return m
