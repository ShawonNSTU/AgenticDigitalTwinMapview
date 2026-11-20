class_name FloorBuilder
extends Node3D
## Builds floor slabs, cut-away walls and room labels from res://data/building.json.

const SLAB := 0.08
const WALL := 0.08

static var current: FloorBuilder  # the floor on screen (devices tint their room through it)
var _slabs := {}  # room key -> StandardMaterial3D
var _tints := {}  # room key -> [colour, amount] from devices working in the room (AC cooling or heating)
var _walls: Array = []
var wall_pieces: Array = []  # [a, b] on the floor for every built wall piece (door gaps left out)
var lintels: Array = []      # [a, b] over each door gap (walk mode only: the walls reach the ceiling)
var ceilings: Node3D         # walk mode: shown once the camera is down at eye height (not seen from above)
var _veil: MeshInstance3D
var _veil_tw: Tween
var _plan_mat: StandardMaterial3D


func build() -> void:
	current = self
	for r in Store.rooms:
		var poly := PlanGeo.room_poly(r)
		var mat := StandardMaterial3D.new()
		mat.albedo_color = Color(r.color).lerp(Color("d9dde3"), 0.55)
		mat.roughness = 0.9
		mat.cull_mode = BaseMaterial3D.CULL_DISABLED
		if str(r.get("finish", "")) == "st-zone":
			_zone_floor(mat)
		elif str(r.get("finish", "")) == "lift-lobby":
			_lobby_floor(mat)
		else:
			_finish(mat, str(r.name).to_lower())
		_slabs[r.key] = mat
		_slab(poly, mat)
		if Store.room_allowed(r.key):
			_room_label(r, poly)
	for n in Store.notes:
		if Store.room_allowed(Store.room_at(Vector2(float(n.x), float(n.z))).get("key", "")) or Store.guest_allowed.is_empty():
			_note(n)
	var wall_mat := StandardMaterial3D.new()
	wall_mat.albedo_color = Color("f2f3f5")
	wall_mat.roughness = 0.8
	var h: float = Store.wall_height
	# Walls follow every room edge (any angle); shared walls are built once; door openings are left open.
	var doors: Array = Store.furniture.filter(func(f): return f.get("kind", "") == "door" and Store.door_open(f))
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
		# an outside wall (a room on one side only) gets windows
		var nrm := Vector2(-u.y, u.x)
		var mid_s := (a + b) / 2
		var side_a: Dictionary = Store.room_at(mid_s + nrm * 0.3)
		var side_b: Dictionary = Store.room_at(mid_s - nrm * 0.3)
		var exterior := side_a.is_empty() != side_b.is_empty() and str(side_a.get("finish", "")) != "lift-lobby" and str(side_b.get("finish", "")) != "lift-lobby"
		var start := -WALL / 2
		for g in gaps + [[length + WALL / 2, length + WALL / 2]]:
			var end: float = g[0]
			if end - start > 0.02:
				_wall_run(a, u, start, end, h, wall_mat, exterior)
				wall_pieces.append([a + u * maxf(start, 0.0), a + u * minf(end, length)])
			if g[1] > g[0] and h > Walker.LINTEL + 0.05:
				# full-height walls (walk mode): the wall closes over the door opening
				var gm: Vector2 = a + u * ((g[0] + g[1]) / 2)
				var lt := _box(Vector3(gm.x, (Walker.LINTEL + h) / 2, gm.y), Vector3(g[1] - g[0], h - Walker.LINTEL, WALL), wall_mat)
				lt.rotation.y = -atan2(u.y, u.x)
				_walls.append(lt)
				lintels.append([a + u * g[0], a + u * g[1]])
			start = maxf(start, g[1])
	for r in Store.rooms:
		if str(r.get("finish", "")) == "st-zone":
			_zone_walls(r, h, doors)
		elif str(r.get("finish", "")) == "lift-lobby":
			_zone_walls(r, h, doors, _lobby_wall_mat(), Color("2e3a5c"))
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
	if Store.plan_texture and not Store.walk:  # walking: real floor finishes, not the drawing
		# The uploaded plan lies on top of the floor so you can see it turn into the 3D map.
		_plan_mat = StandardMaterial3D.new()
		_plan_mat.albedo_texture = Store.plan_texture
		_plan_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		_plan_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		_plan_mat.albedo_color.a = 0.18  # the drawing stays faintly under the 3D floor (play_build_up fades it from full)
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
	var seen := {}
	for w in _walls:
		var m: StandardMaterial3D = w.material_override
		if seen.has(m) or m == _glass:
			continue
		seen[m] = true
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


var _glass: StandardMaterial3D


## One stretch of wall from `start` to `end` metres along the edge. Outside walls get windows: about every
## 3 m a 1.2 m wide window (sill and head at real heights, scaled like the walls) with glass between.
func _wall_run(a: Vector2, u: Vector2, start: float, end: float, h: float, mat: StandardMaterial3D, exterior: bool) -> void:
	var rot := -atan2(u.y, u.x)
	var piece := func(t0: float, t1: float, y0: float, y1: float, m: StandardMaterial3D, depth: float) -> void:
		if t1 - t0 < 0.01 or y1 - y0 < 0.01:
			return
		var c := a + u * ((t0 + t1) / 2)
		var w := _box(Vector3(c.x, (y0 + y1) / 2, c.y), Vector3(t1 - t0, y1 - y0, depth), m)
		w.rotation.y = rot
		_walls.append(w)
	var usable := end - start - 1.2
	var count := int(floor((usable + 1.8) / 3.0)) if exterior and usable > 1.2 else 0
	if count <= 0:
		piece.call(start, end, 0.0, h, mat, WALL)
		return
	if _glass == null:
		_glass = StandardMaterial3D.new()
		_glass.albedo_color = Color(0.62, 0.8, 0.95, 0.38)
		_glass.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		_glass.roughness = 0.05
		_glass.metallic = 0.3
		_glass.cull_mode = BaseMaterial3D.CULL_DISABLED
	var k := minf(h / Placer.REAL_STOREY, 1.0)
	var sill := 0.9 * k
	var head := minf(2.1 * k, h - 0.05)
	var step := (end - start) / count
	var t := start
	for i in count:
		var cw := start + step * (i + 0.5)
		var w0 := cw - 0.6
		var w1 := cw + 0.6
		piece.call(t, w0, 0.0, h, mat, WALL)
		piece.call(w0, w1, 0.0, sill, mat, WALL)
		piece.call(w0, w1, head, h, mat, WALL)
		piece.call(w0, w1, sill, head, _glass, 0.03)
		t = w1
	piece.call(t, end, 0.0, h, mat, WALL)


# ---- the SmartThings Experience Zone: wood-panelled walls, cream floor tiles, drop ceiling (see web/lib/sim/stzone.ts)

static func _grid_tex(px: int, base: Color, line: Color, lw: int, rows := 1) -> ImageTexture:
	var img := Image.create(px, px, false, Image.FORMAT_RGB8)
	img.fill(base)
	for i in px:
		for j in lw:
			img.set_pixel(i, j, line)
			img.set_pixel(j, i, line)
		for rr in range(1, rows):
			for j in lw:
				img.set_pixel(i, rr * px / rows + j, line)
	img.generate_mipmaps()
	return ImageTexture.create_from_image(img)


func _zone_floor(mat: StandardMaterial3D) -> void:
	mat.albedo_color = Color("efe6d2")
	mat.albedo_texture = _grid_tex(64, Color(1, 1, 1), Color(0.8, 0.77, 0.7), 1)
	mat.uv1_triplanar = true
	mat.uv1_world_triplanar = true
	mat.uv1_scale = Vector3.ONE / 0.6  # 600 mm porcelain tiles
	mat.roughness = 0.22
	mat.metallic_specular = 0.7


var _panel_mat: StandardMaterial3D


## Wood cladding on the inside of every wall of the room (big panels with dark grooves), a dark skirting, and
## nothing across the door opening.
func _zone_walls(r: Dictionary, h: float, doors: Array, lining: StandardMaterial3D = null, skirt_col := Color("3a2418")) -> void:
	if lining == null and _panel_mat == null:
		_panel_mat = StandardMaterial3D.new()
		_panel_mat.albedo_color = Color("9b6b40")
		_panel_mat.roughness = 0.38
		var tex := _grid_tex(128, Color(1, 1, 1), Color(0.45, 0.33, 0.22), 2, 2)
		var n := FastNoiseLite.new()
		n.frequency = 0.05
		n.fractal_octaves = 3
		var grain := NoiseTexture2D.new()
		grain.noise = n
		grain.width = 256
		grain.height = 64
		grain.seamless = true
		grain.color_ramp = Gradient.new()
		grain.color_ramp.set_color(0, Color(0.84, 0.78, 0.72))
		grain.color_ramp.set_color(1, Color(1, 1, 1))
		_panel_mat.albedo_texture = tex
		_panel_mat.detail_enabled = true
		_panel_mat.detail_albedo = grain
		_panel_mat.detail_blend_mode = BaseMaterial3D.BLEND_MODE_MUL
		_panel_mat.uv1_triplanar = true
		_panel_mat.uv1_world_triplanar = true
		_panel_mat.uv1_scale = Vector3(1.0 / 2.4, 1.0 / 1.2, 1.0 / 2.4)  # 1.2 m x 0.6 m panels
		_panel_mat.uv2_triplanar = true
		_panel_mat.uv2_world_triplanar = true
		_panel_mat.uv2_scale = Vector3(0.35, 3.0, 0.35)  # grain runs along the panels
	var wall_mat: StandardMaterial3D = lining if lining else _panel_mat
	var skirt := StandardMaterial3D.new()
	skirt.albedo_color = skirt_col
	skirt.roughness = 0.5
	var poly := PlanGeo.room_poly(r)
	var centre := Vector2.ZERO
	for p in poly:
		centre += p
	centre /= poly.size()
	for i in poly.size():
		var a: Vector2 = poly[i]
		var b: Vector2 = poly[(i + 1) % poly.size()]
		var length := a.distance_to(b)
		if length < 0.2:
			continue
		var u := (b - a) / length
		var nrm := Vector2(-u.y, u.x)
		if Geometry2D.is_point_in_polygon((a + b) / 2 + nrm * 0.2, poly) == false:
			nrm = -nrm
		var off := WALL / 2 + 0.012
		var gaps: Array = []
		for dr in doors:
			var p := Vector2(float(dr.x), float(dr.z))
			var t := (p - a).dot(u)
			if t > -0.3 and t < length + 0.3 and absf((p - a).dot(nrm)) < 0.3:
				gaps.append([t - float(dr.w) / 2 - 0.05, t + float(dr.w) / 2 + 0.05])
		var start := off
		for g in gaps + [[length - off, length - off]]:
			var end: float = minf(g[0], length - off)
			if end - start > 0.05:
				var c := a + u * ((start + end) / 2) + nrm * off
				var pnl := _box(Vector3(c.x, h / 2, c.y), Vector3(end - start, h, 0.024), wall_mat)
				pnl.rotation.y = -atan2(u.y, u.x)
				_walls.append(pnl)
				var c2 := a + u * ((start + end) / 2) + nrm * (off + 0.018)
				var sk := _box(Vector3(c2.x, 0.05, c2.y), Vector3(end - start, 0.1, 0.014), skirt)
				sk.rotation.y = -atan2(u.y, u.x)
				_walls.append(sk)
			start = maxf(start, g[1])


func _zone_ceiling_mat() -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = Color("f1efe9")
	m.albedo_texture = _grid_tex(64, Color(1, 1, 1), Color(0.72, 0.72, 0.7), 2)
	m.uv1_triplanar = true
	m.uv1_world_triplanar = true
	m.uv1_scale = Vector3.ONE / 0.6  # 600 mm ceiling tiles
	m.roughness = 1.0
	m.cull_mode = BaseMaterial3D.CULL_DISABLED
	return m


## Drop-ceiling fittings: LED light panels and square AC diffusers set into the grid, and the lowered white band
## along the projector wall where the spot bulbs hang.
func _zone_ceiling(r: Dictionary, h: float) -> void:
	var poly := PlanGeo.room_poly(r)
	var lo := Vector2(INF, INF)
	var hi := Vector2(-INF, -INF)
	for p in poly:
		lo = lo.min(p)
		hi = hi.max(p)
	var sz := hi - lo
	var panel := StandardMaterial3D.new()
	_zone_panels[str(r.key)] = panel
	panel.albedo_color = Color(1, 1, 1)
	panel.emission_enabled = true
	panel.emission = Color(1.0, 0.98, 0.94)
	panel.emission_energy_multiplier = 1.6
	var frame := StandardMaterial3D.new()
	frame.albedo_color = Color("dcdcd8")
	var grille := StandardMaterial3D.new()
	grille.albedo_color = Color("c9cbcc")
	grille.metallic = 0.4
	grille.roughness = 0.5
	var dark := StandardMaterial3D.new()
	dark.albedo_color = Color("2b2e33")
	var fit := func(f: Vector2) -> Vector3:
		# snap to the 600 mm grid inside the room
		var p := lo + sz * f
		p = Vector2(lo.x + 0.3 + snappedf(p.x - lo.x - 0.3, 0.6), lo.y + 0.3 + snappedf(p.y - lo.y - 0.3, 0.6))
		return Vector3(p.x, h - 0.012, p.y)
	for f in [Vector2(0.3, 0.3), Vector2(0.72, 0.3), Vector2(0.3, 0.75), Vector2(0.72, 0.75)]:
		var c: Vector3 = fit.call(f)
		ceilings.add_child(_ceil_box(c, Vector3(0.6, 0.02, 0.6), frame))
		ceilings.add_child(_ceil_box(c + Vector3(0, -0.006, 0), Vector3(0.56, 0.02, 0.56), panel))
	for f in [Vector2(0.52, 0.52), Vector2(0.52, 0.12)]:
		var c: Vector3 = fit.call(f)
		ceilings.add_child(_ceil_box(c, Vector3(0.6, 0.02, 0.6), frame))
		for k in 4:  # concentric square louvres
			var s := 0.54 - k * 0.11
			ceilings.add_child(_ceil_box(c + Vector3(0, -0.012 - k * 0.012, 0), Vector3(s, 0.012, s), grille if k % 2 == 0 else dark))
	# lowered band (bulkhead) along the room's west edge
	var bw := minf(0.55, sz.x * 0.15)
	ceilings.add_child(_ceil_box(Vector3(lo.x + bw / 2 + WALL / 2, h - 0.14, (lo.y + hi.y) / 2), Vector3(bw, 0.28, sz.y - WALL), frame))


var _zone_panels := {}


## The zone's LED ceiling panels follow its "main ceiling lights" device (level 0..1).
func set_panels(room_key: String, level: float) -> void:
	var m: StandardMaterial3D = _zone_panels.get(room_key)
	if m:
		m.emission_energy_multiplier = 0.05 + level * 1.8
		m.albedo_color = Color(0.75, 0.75, 0.73).lerp(Color.WHITE, level)


# ---- the 4th-floor lift lobby (web/lib/sim/stzone.ts): blue walls, wood-plank floor, oval lit ceiling

var _lobby_wall: StandardMaterial3D


func _lobby_wall_mat() -> StandardMaterial3D:
	if _lobby_wall == null:
		_lobby_wall = StandardMaterial3D.new()
		_lobby_wall.albedo_color = Color("5f78bd")
		_lobby_wall.roughness = 0.55
		_lobby_wall.albedo_texture = _grid_tex(128, Color(1, 1, 1), Color(0.88, 0.9, 0.95), 1)
		_lobby_wall.uv1_triplanar = true
		_lobby_wall.uv1_world_triplanar = true
		_lobby_wall.uv1_scale = Vector3(1.0 / 2.6, 1.0 / 4.0, 1.0 / 2.6)  # large painted board joints
	return _lobby_wall


func _lobby_floor(mat: StandardMaterial3D) -> void:
	# warm wood planks: 1.2 m x 0.18 m boards, staggered, with grain
	var w := 256
	var img := Image.create(w, w, false, Image.FORMAT_RGB8)
	var n := FastNoiseLite.new()
	n.frequency = 0.05
	var rng := RandomNumberGenerator.new()
	rng.seed = 4
	var rows := 8
	var tones: Array = []
	for i in rows * 3:
		tones.append(rng.randf_range(-0.06, 0.06))
	for y in w:
		var row := y * rows / w
		for x in w:
			var off := (row % 3) * w / 3
			var board := ((x + off) % w) * 2 / w
			var t: float = tones[(row * 2 + board) % tones.size()]
			var g := n.get_noise_2d(x * 0.15, y * 3.0) * 0.08
			var c := Color(0.58 + t + g, 0.33 + t * 0.7 + g * 0.6, 0.19 + t * 0.4 + g * 0.3)
			if y % (w / rows) == 0 or (x + off) % (w / 2) == 0:
				c = c.darkened(0.35)
			img.set_pixel(x, y, c)
	img.generate_mipmaps()
	mat.albedo_color = Color.WHITE
	mat.albedo_texture = ImageTexture.create_from_image(img)
	mat.uv1_triplanar = true
	mat.uv1_world_triplanar = true
	mat.uv1_scale = Vector3.ONE / 1.44
	mat.roughness = 0.35
	mat.metallic_specular = 0.6


## White ceiling with a big oval lit cove in the middle and a row of downlights round it.
func _lobby_ceiling(r: Dictionary, h: float) -> void:
	var poly := PlanGeo.room_poly(r)
	var lo := Vector2(INF, INF)
	var hi := Vector2(-INF, -INF)
	for p in poly:
		lo = lo.min(p)
		hi = hi.max(p)
	var c := (lo + hi) / 2
	var sz := hi - lo
	var cove := StandardMaterial3D.new()
	cove.albedo_color = Color(0.95, 1.0, 0.96)
	cove.emission_enabled = true
	cove.emission = Color(0.9, 1.0, 0.92)
	cove.emission_energy_multiplier = 0.8
	var white := StandardMaterial3D.new()
	white.albedo_color = Color("f2f2f0")
	var ring := MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = 0.92
	tm.outer_radius = 1.0
	tm.rings = 64
	ring.mesh = tm
	ring.material_override = cove
	ring.scale = Vector3(sz.x * 0.42, 0.06, sz.y * 0.42)
	ring.position = Vector3(c.x, h - 0.03, c.y)
	ceilings.add_child(ring)
	# the raised oval inside the cove, a shade brighter
	var disc := MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = 0.92
	cm.bottom_radius = 0.92
	cm.height = 0.01
	disc.mesh = cm
	var inner := white.duplicate() as StandardMaterial3D
	inner.emission_enabled = true
	inner.emission = Color(1, 1, 1)
	inner.emission_energy_multiplier = 0.08
	disc.material_override = inner
	disc.scale = Vector3(sz.x * 0.42, 1, sz.y * 0.42)
	disc.position = Vector3(c.x, h - 0.012, c.y)
	ceilings.add_child(disc)
	var dl := StandardMaterial3D.new()
	dl.albedo_color = Color.WHITE
	dl.emission_enabled = true
	dl.emission = Color(1, 1, 0.97)
	dl.emission_energy_multiplier = 3.0
	for i in 7:
		var x := lo.x + sz.x * (0.12 + i * 0.125)
		for z in [lo.y + 0.45, hi.y - 0.45]:
			var d := MeshInstance3D.new()
			var dm := CylinderMesh.new()
			dm.top_radius = 0.07
			dm.bottom_radius = 0.07
			dm.height = 0.01
			d.mesh = dm
			d.material_override = dl
			d.position = Vector3(x, h - 0.012, z)
			ceilings.add_child(d)
	var lamp := OmniLight3D.new()
	lamp.position = Vector3(c.x, h - 0.4, c.y)
	lamp.omni_range = maxf(sz.x, sz.y) * 0.8
	lamp.light_energy = 1.4
	lamp.light_color = Color(0.92, 1.0, 0.95)
	ceilings.add_child(lamp)


func _ceil_box(c: Vector3, s: Vector3, m: Material) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = s
	mi.mesh = bm
	mi.material_override = m
	mi.position = c
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	return mi


## Ceilings for the walk-through: one per room at the wall top, facing down, casting no shadow.
func _ceilings(h: float) -> void:
	ceilings = Node3D.new()
	ceilings.name = "Ceilings"
	ceilings.visible = false
	add_child(ceilings)
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
		ceilings.add_child(m)
		if str(r.get("finish", "")) == "st-zone":
			m.material_override = _zone_ceiling_mat()
			_zone_ceiling(r, h)
		elif str(r.get("finish", "")) == "lift-lobby":
			_lobby_ceiling(r, h)


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


var _selected := ""


func _base(key: String) -> Color:
	var r: Dictionary = Store.room(key)
	return Color(r.color).lerp(Color("d9dde3"), 0.55) if not r.is_empty() else Color("d9dde3")


## A device working in a room tints its floor (amount 0 clears it).
func climate_tint(key: String, col: Color, amount: float) -> void:
	if not _slabs.has(key):
		return
	var was: Array = _tints.get(key, [col, 0.0])
	if is_equal_approx(was[1], amount) and was[0] == col:
		return
	_tints[key] = [col, amount]
	if key == _selected:
		return
	var m: StandardMaterial3D = _slabs[key]
	create_tween().tween_property(m, "albedo_color", _base(key).lerp(col, amount), 1.2)


## Highlights one room's floor (a click on the map); "" clears it.
func select_room(key: String) -> void:
	if _selected != "" and _slabs.has(_selected):
		var r: Dictionary = Store.room(_selected)
		if not r.is_empty():
			_slabs[_selected].albedo_color = Color(r.color).lerp(Color("d9dde3"), 0.55)
	_selected = key
	if key != "" and _slabs.has(key):
		var m: StandardMaterial3D = _slabs[key]
		m.albedo_color = m.albedo_color.lerp(Color("3b82f6"), 0.45)


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
