class_name FloorBuilder
extends Node3D
## Builds floor slabs, cut-away walls and room labels from res://data/building.json.

const SLAB := 0.08
const WALL := 0.08

var _slabs := {}  # room key -> StandardMaterial3D
var _walls: Array = []
var _plan_mat: StandardMaterial3D


func build() -> void:
	for r in Store.rooms:
		var poly := PlanGeo.room_poly(r)
		var mat := StandardMaterial3D.new()
		mat.albedo_color = Color(r.color).lerp(Color("d9dde3"), 0.55)
		mat.roughness = 0.9
		mat.cull_mode = BaseMaterial3D.CULL_DISABLED
		_slabs[r.key] = mat
		_slab(poly, mat)
		var label := Label3D.new()
		label.text = r.name
		label.font_size = 48
		label.pixel_size = 0.004
		label.modulate = Color(0.15, 0.18, 0.22, 0.75)
		label.outline_size = 0
		label.rotation = Vector3(-PI / 2, 0, 0)
		var c := PlanGeo.interior_point(poly)
		label.position = Vector3(c.x, 0.012, c.y)
		add_child(label)
	var wall_mat := StandardMaterial3D.new()
	wall_mat.albedo_color = Color("f2f3f5")
	wall_mat.roughness = 0.8
	var h: float = Store.wall_height
	# Walls follow every room edge (any angle); shared walls are built once.
	for s in PlanGeo.wall_segments(Store.rooms):
		var a: Vector2 = s[0]
		var b: Vector2 = s[1]
		var w := _box(Vector3((a.x + b.x) / 2, h / 2, (a.y + b.y) / 2), Vector3(a.distance_to(b) + WALL, h, WALL), wall_mat)
		w.rotation.y = -atan2(b.y - a.y, b.x - a.x)
		_walls.append(w)
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


## While a device twin is open, walls turn to glass so they never hide it.
func set_walls_faded(on: bool) -> void:
	if _walls.is_empty():
		return
	var m: StandardMaterial3D = _walls[0].material_override
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA if on else BaseMaterial3D.TRANSPARENCY_DISABLED
	m.albedo_color.a = 0.18 if on else 1.0


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
