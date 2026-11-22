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
var _base_col := {}   # each floor's own colour (its finish), to come back to after a highlight or tint


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
			_finish(mat, str(r.name).to_lower(), Color(r.color))
		_slabs[r.key] = mat
		_base_col[r.key] = mat.albedo_color
		_slab(poly, mat)
		if Store.room_allowed(r.key):
			if not Store.walk:   # walking: no names painted on the floor
				_room_label(r, poly)
	if Store.walk:
		_signs()
	for n in Store.notes:
		if Store.room_allowed(Store.room_at(Vector2(float(n.x), float(n.z))).get("key", "")) or Store.guest_allowed.is_empty():
			_note(n)
	var wall_mat := StandardMaterial3D.new()
	wall_mat.albedo_color = Color.WHITE
	wall_mat.albedo_texture = _plaster_tex()
	wall_mat.uv1_triplanar = true
	wall_mat.uv1_world_triplanar = true
	wall_mat.uv1_scale = Vector3.ONE / 0.8
	wall_mat.roughness = 0.85
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


## Floor finish from the room's name, as such rooms are finished in real buildings: glazed ceramic tiles in wet
## rooms, carpet tiles where people sit, work or pray, rubber in the gym, polished terrazzo in corridors, lobbies and
## passages, wood-look vinyl planks elsewhere (cafeterias, offices, any other room). The room's plan colour stays as
## a faint tint on the map; walking, the floor shows its real colour.
const WET := ["toilet", "bath", "ablution", "wash", "kitchen", "laundry", "utility", "a/c", "outdoor", "shower", "wc"]
const SOFT := ["pray", "training", "class", "bed", "maternity", "workspace", "media", "living", "office", "meeting", "conference", "study", "medical"]
const HARD := ["corridor", "passage", "lobby", "hall", "foyer", "entrance", "stair", "landing", "store", "hub"]

func _finish(mat: StandardMaterial3D, name: String, tint: Color) -> void:
	var kind := "vinyl"
	for k in HARD:
		if name.contains(k):
			kind = "terrazzo"
	for k in SOFT:
		if name.contains(k):
			kind = "carpet"
	for k in WET:
		if name.contains(k):
			kind = "ceramic"
	if name.contains("gym") or name.contains("fitness"):
		kind = "rubber"
	var size: float = {"ceramic": 0.6, "carpet": 1.0, "rubber": 1.0, "terrazzo": 1.2, "vinyl": 1.2}[kind]
	mat.albedo_texture = _floor_tex(kind)
	mat.uv1_triplanar = true
	mat.uv1_world_triplanar = true
	mat.uv1_scale = Vector3.ONE / size
	mat.roughness = float({"ceramic": 0.28, "carpet": 1.0, "rubber": 0.85, "terrazzo": 0.22, "vinyl": 0.5}[kind])
	mat.metallic_specular = 0.6 if kind in ["ceramic", "terrazzo"] else 0.4
	mat.albedo_color = Color.WHITE if Store.walk else Color.WHITE.lerp(tint, 0.28)


## Floor textures, one repeat each (sizes in _finish), made once procedurally.
static func _floor_tex(kind: String) -> ImageTexture:
	var key := "floor_" + kind
	if _tex_cache.has(key):
		return _tex_cache[key]
	var n := 256
	var img := Image.create(n, n, false, Image.FORMAT_RGB8)
	var rng := RandomNumberGenerator.new()
	rng.seed = 11
	var fine := FastNoiseLite.new()
	fine.seed = 31
	fine.frequency = 0.5
	var cloud := FastNoiseLite.new()
	cloud.seed = 5
	cloud.frequency = 0.03
	cloud.fractal_octaves = 3
	match kind:
		"ceramic":  # 2 x 2 tiles of 300 mm, each a slightly different shade, light grey grout
			var tones := [rng.randf_range(-0.03, 0.03), rng.randf_range(-0.03, 0.03), rng.randf_range(-0.03, 0.03), rng.randf_range(-0.03, 0.03)]
			var base := Color("e6e8ea")
			for y in n:
				for x in n:
					var t: float = tones[int(x >= n / 2) + 2 * int(y >= n / 2)]
					var c := base.lightened(t) if t > 0 else base.darkened(-t)
					c = c.darkened(maxf(cloud.get_noise_2d(x, y), 0.0) * 0.05)
					if x % (n / 2) < 3 or y % (n / 2) < 3:
						c = Color("b8bcc0")
					img.set_pixel(x, y, c)
		"carpet":  # a 500 mm carpet tile, 2 x 2, pile direction turned on alternate tiles (quarter-turn laying)
			var base := Color("6b7280")
			for y in n:
				for x in n:
					var q := int(x >= n / 2) + int(y >= n / 2)
					var streak := sin((x if q % 2 == 0 else y) * 0.9) * 0.025
					var c := base.lightened(fine.get_noise_2d(x, y) * 0.12 + streak + cloud.get_noise_2d(x, y) * 0.04)
					if x % (n / 2) == 0 or y % (n / 2) == 0:
						c = c.darkened(0.08)
					img.set_pixel(x, y, c)
		"rubber":  # gym rubber: dark grey with coloured EPDM flecks, 1 m tiles
			var base := Color("34373c")
			img.fill(base)
			for y in n:
				for x in n:
					img.set_pixel(x, y, base.lightened(fine.get_noise_2d(x, y) * 0.06))
			for i in 2600:
				var x := rng.randi_range(0, n - 2)
				var y := rng.randi_range(0, n - 2)
				var col: Color = [Color("8a8f96"), Color("5d8fc9"), Color("c9c9c9"), Color("4d5157")][rng.randi_range(0, 3)]
				img.set_pixel(x, y, col)
				if rng.randf() < 0.4:
					img.set_pixel(x + 1, y, col)
			for i in n:
				img.set_pixel(i, 0, Color("26282c"))
				img.set_pixel(0, i, Color("26282c"))
		"terrazzo":  # polished terrazzo, 2 x 2 tiles of 600 mm: pale grey with stone chips, a fine joint
			var base := Color("d9d7d2")
			for y in n:
				for x in n:
					img.set_pixel(x, y, base.darkened(maxf(cloud.get_noise_2d(x, y), 0.0) * 0.06).lightened(fine.get_noise_2d(x, y) * 0.02))
			for i in 1800:
				var x := rng.randi_range(1, n - 3)
				var y := rng.randi_range(1, n - 3)
				var col: Color = [Color("8f8b84"), Color("b6aea2"), Color("6f7377"), Color("efece6"), Color("a39582")][rng.randi_range(0, 4)]
				var sz := rng.randi_range(1, 2)
				for dy in sz:
					for dx in sz:
						img.set_pixel(x + dx, y + dy, col)
			for i in n:
				for k in [0, n / 2]:
					img.set_pixel(i, k, Color("b3b0aa"))
					img.set_pixel(k, i, Color("b3b0aa"))
		_:  # wood-look vinyl planks: 1.2 m x 0.2 m (6 boards across), staggered joints, grain along the board
			var rows := 6
			var light := Color("c4a27c")
			var dark := Color("9b7653")
			var tones: Array = []
			var offs: Array = []
			for i in rows:
				tones.append(rng.randf_range(-0.07, 0.07))
				offs.append(rng.randi_range(0, n - 1))
			var grain := FastNoiseLite.new()
			grain.seed = 17
			grain.frequency = 0.01
			for y in n:
				var row := y * rows / n
				for x in n:
					var t := float(y) * 0.9 + grain.get_noise_2d(x * 0.3, y * 2.0) * 6.0
					var line := pow(0.5 + 0.5 * sin(t), 8.0)
					var c := light.lerp(dark, clampf(line * 0.35 + (cloud.get_noise_2d(x * 0.4, y) * 0.5 + 0.5) * 0.25, 0.0, 1.0))
					var tn: float = tones[row]
					c = c.lightened(tn) if tn > 0 else c.darkened(-tn)
					if y % (n / rows) == 0 or (x + int(offs[row])) % n == 0:
						c = c.darkened(0.3)
					img.set_pixel(x, y, c)
	img.generate_mipmaps()
	_tex_cache[key] = ImageTexture.create_from_image(img)
	return _tex_cache[key]


## Painted plaster walls: off-white with the faint orange-peel of rolled emulsion paint.
static func _plaster_tex() -> ImageTexture:
	if _tex_cache.has("plaster"):
		return _tex_cache.plaster
	var n := 128
	var img := Image.create(n, n, false, Image.FORMAT_RGB8)
	var fine := FastNoiseLite.new()
	fine.seed = 41
	fine.frequency = 0.6
	var cloud := FastNoiseLite.new()
	cloud.seed = 43
	cloud.frequency = 0.04
	var base := Color("f1efea")
	for y in n:
		for x in n:
			img.set_pixel(x, y, base.darkened(maxf(fine.get_noise_2d(x, y), 0.0) * 0.035 + maxf(cloud.get_noise_2d(x, y), 0.0) * 0.025))
	img.generate_mipmaps()
	_tex_cache.plaster = ImageTexture.create_from_image(img)
	return _tex_cache.plaster


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
var _skirt_mat: StandardMaterial3D
func _skirting() -> StandardMaterial3D:
	if _skirt_mat == null:
		_skirt_mat = StandardMaterial3D.new()
		_skirt_mat.albedo_color = Color("5c5f63")
		_skirt_mat.roughness = 0.45
	return _skirt_mat


func _wall_run(a: Vector2, u: Vector2, start: float, end: float, h: float, mat: StandardMaterial3D, exterior: bool) -> void:
	var rot := -atan2(u.y, u.x)
	var piece := func(t0: float, t1: float, y0: float, y1: float, m: StandardMaterial3D, depth: float) -> void:
		if t1 - t0 < 0.01 or y1 - y0 < 0.01:
			return
		var c := a + u * ((t0 + t1) / 2)
		var w := _box(Vector3(c.x, (y0 + y1) / 2, c.y), Vector3(t1 - t0, y1 - y0, depth), m)
		w.rotation.y = rot
		_walls.append(w)
		if y0 == 0.0 and m == mat and Store.walk:  # a painted skirting board on both faces, as in any finished room
			var sk := _box(Vector3(c.x, 0.05, c.y), Vector3(t1 - t0, 0.1, depth + 0.024), _skirting())
			sk.rotation.y = rot
			_walls.append(sk)
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
	mat.albedo_color = Color.WHITE
	mat.albedo_texture = _porcelain_tex()
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
		# varnished oak cladding as in the room: 1.2 x 0.6 m panels, grain along them, thin dark grooves, a sheen
		_panel_mat = StandardMaterial3D.new()
		_panel_mat.albedo_texture = _oak_panel_tex()
		_panel_mat.roughness = 0.28
		_panel_mat.metallic_specular = 0.6
		_panel_mat.uv1_triplanar = true
		_panel_mat.uv1_world_triplanar = true
		_panel_mat.uv1_scale = Vector3(1.0 / 1.2, 1.0 / 0.6, 1.0 / 1.2)
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
	m.albedo_color = Color.WHITE
	m.albedo_texture = _mineral_tile_tex()
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
	var spec: Dictionary = r.get("ceiling", {})
	if not spec.is_empty():
		_zone_ceiling_spec(spec, h, panel, frame, grille, dark)
		return
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


## The zone's ceiling as the platform lays it out (stzone.ts, from the room's photos): the lowered band where the
## spot bulbs hang, LED panels (they follow the "TV Lamp" device), supply diffusers and a return grille.
func _zone_ceiling_spec(spec: Dictionary, h: float, panel: Material, frame: Material, grille: Material, dark: Material) -> void:
	for p in spec.get("panels", []):
		var c := Vector3(float(p.x), h - 0.012, float(p.z))
		ceilings.add_child(_ceil_box(c, Vector3(float(p.w), 0.02, float(p.d)), frame))
		ceilings.add_child(_ceil_box(c + Vector3(0, -0.006, 0), Vector3(float(p.w) - 0.04, 0.02, float(p.d) - 0.04), panel))
	for p in spec.get("diffusers", []):
		var c := Vector3(float(p.x), h - 0.012, float(p.z))
		ceilings.add_child(_ceil_box(c, Vector3(0.6, 0.02, 0.6), frame))
		for k in 4:  # concentric square louvres
			var s := 0.54 - k * 0.11
			ceilings.add_child(_ceil_box(c + Vector3(0, -0.012 - k * 0.012, 0), Vector3(s, 0.012, s), grille if k % 2 == 0 else dark))
	for p in spec.get("returns", []):
		var c := Vector3(float(p.x), h - 0.012, float(p.z))
		ceilings.add_child(_ceil_box(c, Vector3(0.6, 0.02, 0.6), frame))
		ceilings.add_child(_ceil_box(c + Vector3(0, -0.008, 0), Vector3(0.44, 0.012, 0.44), dark))
	var drop := float(spec.get("drop", 0.28))
	for b in spec.get("band", []):
		ceilings.add_child(_ceil_box(Vector3(float(b.x), h - drop / 2, float(b.z)), Vector3(float(b.w), drop, float(b.d)), frame))


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
	return _base_col.get(key, Color("d9dde3"))


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
		_slabs[_selected].albedo_color = _base(_selected)
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
		var base := _base(r.key)
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



# ---- textures for the SmartThings zone (made once, procedurally: no image files)

static var _tex_cache := {}


## One 1.2 x 0.6 m oak panel: golden oak with flowing grain and darker late-wood lines, a thin dark groove round it.
static func _oak_panel_tex() -> ImageTexture:
	if _tex_cache.has("oak"):
		return _tex_cache.oak
	var w := 384
	var h := 192
	var img := Image.create(w, h, false, Image.FORMAT_RGB8)
	# straight-ish grain along the panel: many thin darker lines that wander a little, broad tone changes along
	# the length, faint pores; low contrast like varnished oak veneer
	var wander := FastNoiseLite.new()
	wander.seed = 7
	wander.frequency = 0.004
	var tone := FastNoiseLite.new()
	tone.seed = 19
	tone.frequency = 0.012
	var pore := FastNoiseLite.new()
	pore.seed = 23
	pore.frequency = 0.35
	var light := Color("b98455")
	var dark := Color("7f5131")
	for y in h:
		for x in w:
			var t := float(y) / h * 26.0 + wander.get_noise_2d(x * 0.6, y * 0.8) * 3.0
			var line := pow(0.5 + 0.5 * sin(t * TAU), 12.0)
			var k := line * 0.32 + (tone.get_noise_2d(x, y * 0.15) * 0.5 + 0.5) * 0.22 + maxf(pore.get_noise_2d(x * 0.4, y * 3.0), 0.0) * 0.12
			var c := light.lerp(dark, clampf(k, 0.0, 1.0))
			if x < 1 or x >= w - 1 or y < 1 or y >= h - 1:
				c = Color("3b2415")       # the V-groove between panels
			elif x < 2 or x >= w - 2 or y < 2 or y >= h - 2:
				c = c.darkened(0.25)
			img.set_pixel(x, y, c)
	img.generate_mipmaps()
	_tex_cache.oak = ImageTexture.create_from_image(img)
	return _tex_cache.oak


## One 600 mm cream porcelain tile: faint stone cloud, a thin light-grey grout line.
static func _porcelain_tex() -> ImageTexture:
	if _tex_cache.has("porcelain"):
		return _tex_cache.porcelain
	var n := 256
	var img := Image.create(n, n, false, Image.FORMAT_RGB8)
	var cloud := FastNoiseLite.new()
	cloud.seed = 3
	cloud.frequency = 0.02
	cloud.fractal_octaves = 4
	var base := Color("ece3d1")
	for y in n:
		for x in n:
			var c := base.lerp(Color("d9cdb6"), clampf(cloud.get_noise_2d(x, y) * 0.6 + 0.25, 0.0, 1.0) * 0.5)
			if x < 2 or y < 2:
				c = Color("b9b2a6")
			img.set_pixel(x, y, c)
	img.generate_mipmaps()
	_tex_cache.porcelain = ImageTexture.create_from_image(img)
	return _tex_cache.porcelain


## One 600 mm mineral-fibre ceiling tile: off-white with the fissures and specks of the real tiles, a grey T-bar edge.
static func _mineral_tile_tex() -> ImageTexture:
	if _tex_cache.has("mineral"):
		return _tex_cache.mineral
	var n := 256
	var img := Image.create(n, n, false, Image.FORMAT_RGB8)
	var rng := RandomNumberGenerator.new()
	rng.seed = 5
	var base := Color("f2f0ea")
	img.fill(base)
	for i in 900:   # short dark fissures
		var x := rng.randi_range(4, n - 6)
		var y := rng.randi_range(4, n - 6)
		var ln := rng.randi_range(1, 4)
		var dx := rng.randi_range(-1, 1)
		for k in ln:
			var px := clampi(x + dx * k, 3, n - 4)
			var py := clampi(y + k, 3, n - 4)
			img.set_pixel(px, py, base.darkened(rng.randf_range(0.25, 0.55)))
	for i in n:
		for k in 3:
			img.set_pixel(i, k, Color("cfccc6"))
			img.set_pixel(k, i, Color("cfccc6"))
	img.generate_mipmaps()
	_tex_cache.mineral = ImageTexture.create_from_image(img)
	return _tex_cache.mineral



## Wayfinding while walking, as in a finished building: a name plate on the wall beside each room's door, read from
## the side you come from, and a lit EXIT sign over every door into a stair. Corridors, passages and lobbies have
## no plates.
const _NO_PLATE := ["corridor", "passage", "lobby", "hall", "foyer", "recess"]

func _signs() -> void:
	var plate_mat := StandardMaterial3D.new()
	plate_mat.albedo_color = Color("2b3446")
	plate_mat.roughness = 0.4
	var exit_mat := StandardMaterial3D.new()
	exit_mat.albedo_color = Color("16a34a")
	exit_mat.emission_enabled = true
	exit_mat.emission = Color("22c55e")
	exit_mat.emission_energy_multiplier = 1.4
	for f in Store.furniture:
		if f.get("kind", "") != "door" or f.get("opening", false) or not Store.door_open(f):
			continue
		var c := Vector2(float(f.x), float(f.z))
		var rot := float(f.get("rot", 0.0))
		var u := Vector2(cos(rot), -sin(rot))
		var n := Vector2(sin(rot), cos(rot))
		var w := float(f.w)
		for side in [1.0, -1.0]:
			var into: Dictionary = Store.room_at(c + n * side * 0.5)
			var from: Dictionary = Store.room_at(c - n * side * 0.5)
			if into.is_empty() or from.is_empty() or not Store.room_allowed(str(from.key)):
				continue
			var name := Store.room_label(into)
			var low := name.to_lower()
			var out_dir: Vector2 = -n * side   # facing the corridor side, where you read it
			var face := atan2(out_dir.x, out_dir.y)
			if low.contains("stair"):
				var at := c + out_dir * (WALL / 2 + 0.03)
				var y := minf(Walker.LINTEL + 0.14, Store.wall_height - 0.12)
				var box := _box(Vector3(at.x, y, at.y), Vector3(0.36, 0.14, 0.04), exit_mat)
				box.rotation.y = face
				var ex := Label3D.new()
				ex.text = "EXIT"
				ex.font_size = 48
				ex.pixel_size = 0.0022
				ex.modulate = Color.WHITE
				ex.outline_size = 0
				ex.double_sided = false
				ex.position = Vector3(at.x + out_dir.x * 0.025, y, at.y + out_dir.y * 0.025)
				ex.rotation.y = face
				add_child(ex)
				continue
			var skip := false
			for k in _NO_PLATE:
				if low.contains(k):
					skip = true
			if skip:
				continue
			# beside the door on the latch side (away from the hinge), at eye level
			var along := u * (w / 2 + 0.32) * (1.0 if side > 0 else -1.0)
			var at2 := c + along + out_dir * (WALL / 2 + 0.012)
			var pw := clampf(0.1 + name.length() * 0.032, 0.3, 0.7)
			var plate := _box(Vector3(at2.x, 1.5, at2.y), Vector3(pw, 0.13, 0.012), plate_mat)
			plate.rotation.y = face
			var lb := Label3D.new()
			lb.text = name
			lb.font_size = 48
			lb.pixel_size = minf(0.0021, (pw - 0.06) / maxf(name.length() * 26.0, 1.0))
			lb.modulate = Color("f1f5f9")
			lb.outline_size = 0
			lb.double_sided = false   # read from the corridor side only
			lb.position = Vector3(at2.x + out_dir.x * 0.008, 1.5, at2.y + out_dir.y * 0.008)
			lb.rotation.y = face
			add_child(lb)
