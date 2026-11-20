class_name Placer
extends Node3D
## Places SmartThings devices on the floor: a device dragged from the host page's palette (dragStart /
## dragMove / dragEnd with the pointer in 0..1 viewport coordinates), or a placed device being moved
## (startMove, then the pointer inside the 3D view; click to put it down, Esc to cancel).
##
## While dragging, a see-through copy of the device follows the pointer and snaps the way that type is
## installed: wall units (AC, TV, camera, sensors, plug, blinds) go flat on a wall of the room, facing in, clear
## of doors and corners (blinds prefer an outside wall); door lock and doorbell go beside the nearest door;
## appliances (fridge, washer, dryer, oven) stand with their back to the nearest wall; free-standing units
## (purifier, speaker, vacuum, leak sensor) stand where dropped; lights go on the ceiling; outdoor units go
## outside or in a plant room. Floor units are kept out of furniture and other devices.
##
## The pointer ray meets the walls before the floor, so pointing at a wall picks that wall, in the room on the
## camera's side (not the room behind it); an outside wall seen from outside picks the room it encloses. The room under the pointer is outlined, green if the device can go
## there, red if not. On drop the renderer reports the placement to the host, which adds it to the platform.
##
## Heights: the map shows walls cut away at Store.wall_height (about 1.15 m), so mounting heights are real
## heights scaled to that cut: a wall AC sits near the top of the cut wall, a thermostat at mid height, lights at
## the cut plane (the ceiling of the cut-away model). mount_y() is used for every device the map shows.

const REAL_STOREY := 2.8   # metres: the real floor-to-ceiling height the scaled mounting heights refer to
## Real mounting height of the device's centre on a wall (metres above the floor).
const WALL_Y := {"ac": 2.35, "tv": 1.3, "blinds": 2.05, "camera": 2.45, "temphum": 1.5, "motion": 2.35, "plug": 0.3,
	"doorbell": 1.4, "lock": 1.0}
const WALL := ["ac", "tv", "blinds", "camera", "temphum", "motion", "plug"]
const DOOR := ["lock", "doorbell"]
const AGAINST_WALL := ["fridge", "washer", "dryer", "oven"]
const FREE_FLOOR := ["purifier", "speaker", "vacuum", "leak"]
const ALL := WALL + DOOR + AGAINST_WALL + FREE_FLOOR + ["light", "odu"]
const OUTDOOR_ROOMS := "outdoor|balcony|terrace|roof|plant|a/c|ac room|yard|garden|patio|deck"
const OK_COL := Color("3fb950")
const BAD_COL := Color("f85149")

var rig: CameraRig
var type := ""
var move_id := ""          # moving a placed device (empty while dropping a new one)
var place := {}            # current placement: {x, y, z, rotationY, room, valid, mount}
var _ghost: DeviceNode
var _marker: MeshInstance3D
var _stem: MeshInstance3D
var _label: Label3D
var _outline: Node3D
var _outline_key := "~"
var _mark_mat := StandardMaterial3D.new()
var _ghost_mat := StandardMaterial3D.new()


func _ready() -> void:
	Bus.place_started.connect(start)
	Bus.place_moved.connect(func(uv): if active(): _update(_screen(uv)))
	Bus.place_ended.connect(func(uv, drop):
		if not active():
			return
		_update(_screen(uv))
		finish(drop))
	_ghost_mat.emission_enabled = true
	for m in [_mark_mat, _ghost_mat]:
		m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		m.no_depth_test = true
		m.render_priority = 2


func active() -> bool:
	return type != ""


func start(new_type: String, id := "") -> void:
	cancel()
	move_id = id
	if id != "":
		var d: Dictionary = Store.by_id.get(id, {})
		if d.is_empty():
			return
		new_type = d.type
	if not ALL.has(new_type):
		return
	type = new_type
	_ghost = DeviceNode.new()
	add_child(_ghost)
	_ghost.setup({"id": "Ghost", "type": type, "position": [0, -50, 0], "rotationY": 0.0, "name": ""})
	for a in _ghost.find_children("*", "Area3D", true, false):
		(a as Area3D).input_ray_pickable = false
	_ghost.label.visible = false
	_ghost.ring.visible = false
	_ghost.beam.visible = false
	_ghost.body.material_override = _ghost_mat
	_ghost.scale = Vector3.ONE * 1.4  # a little larger than life so it reads from the whole-floor view
	_marker = MeshInstance3D.new()
	var disc := CylinderMesh.new()
	disc.top_radius = 0.32
	disc.bottom_radius = 0.32
	disc.height = 0.01
	_marker.mesh = disc
	_marker.material_override = _mark_mat
	add_child(_marker)
	_stem = MeshInstance3D.new()
	var stem := CylinderMesh.new()
	stem.top_radius = 0.012
	stem.bottom_radius = 0.012
	stem.height = 1.0
	_stem.mesh = stem
	_stem.material_override = _mark_mat
	add_child(_stem)
	_label = Label3D.new()
	_label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	_label.no_depth_test = true
	_label.fixed_size = true
	_label.pixel_size = 0.0007
	_label.font_size = 26
	_label.outline_size = 10
	_label.render_priority = 3
	add_child(_label)
	_outline = Node3D.new()
	add_child(_outline)
	_outline_key = "~"
	visible = false  # until the pointer is over the floor
	if move_id != "" and Store.by_id.has(move_id):  # start where the device is
		var d: Dictionary = Store.by_id[move_id]
		_update_at(Vector2(d.position[0], d.position[2]))


func cancel() -> void:
	for n in get_children():
		n.queue_free()
	type = ""
	move_id = ""
	place = {}
	_ghost = null
	visible = true


## Puts the device down (drop = true) or gives up. Returns the placement it reported, or {}.
func finish(drop: bool) -> Dictionary:
	var out := {}
	if drop and visible and place.get("valid", false):
		out = {"x": snappedf(place.x, 0.001), "y": snappedf(place.y, 0.001), "z": snappedf(place.z, 0.001),
			"rotationY": snappedf(place.rotationY, 0.0001), "room": place.room}
		if move_id != "":
			out["id"] = move_id
			Bus.device_moved.emit(out)
		else:
			out["deviceType"] = type
			Bus.device_dropped.emit(out)
		_splash(Vector3(place.x, 0.02, place.z))
	cancel()
	return out


func _screen(uv: Vector2) -> Vector2:
	return uv * get_viewport().get_visible_rect().size


## Pointer (viewport pixels) -> point on the floor. A wall in front of the floor point wins: the point is put just
## inside the wall on the camera's side, so the device goes to the room the user is looking into.
func _update(screen: Vector2) -> void:
	if rig == null or rig.cam == null:
		return
	var p = pointer_floor(rig.cam, screen)
	if p == null:
		visible = false
		return
	_update_at(p)


static var _segs: Array = []
static var _segs_rooms := -1


static func pointer_floor(cam: Camera3D, screen: Vector2) -> Variant:
	var o := cam.project_ray_origin(screen)
	var dir := cam.project_ray_normal(screen)
	var t_floor := INF
	if dir.y < -1e-4:
		t_floor = -o.y / dir.y
	if Store.rooms.hash() != _segs_rooms:
		_segs = PlanGeo.wall_segments(Store.rooms)
		_segs_rooms = Store.rooms.hash()
	var h: float = Store.wall_height
	var best := t_floor
	var hit_n := Vector2.ZERO
	for s in _segs:
		var a: Vector2 = s[0]
		var b: Vector2 = s[1]
		var e := b - a
		var n := Vector2(-e.y, e.x).normalized()
		var denom := dir.x * n.x + dir.z * n.y
		if absf(denom) < 1e-6:
			continue
		var t := ((a.x - o.x) * n.x + (a.y - o.z) * n.y) / denom
		if t <= 0.0 or t >= best:
			continue
		var q := o + dir * t
		if q.y < 0.0 or q.y > h:
			continue
		var along := (Vector2(q.x, q.z) - a).dot(e) / e.length_squared()
		if along < 0.0 or along > 1.0:
			continue
		best = t
		hit_n = n if denom < 0.0 else -n  # the wall side facing the camera
	if best == INF:
		return null
	var hit := o + dir * best
	var p := Vector2(hit.x, hit.z)
	if hit_n == Vector2.ZERO:
		return p
	# the room on the camera's side of the wall; an outside wall seen from outside means the room behind it
	var near := p + hit_n * 0.12
	var far := p - hit_n * 0.12
	return near if not Store.room_at(near).is_empty() or Store.room_at(far).is_empty() else far


func _update_at(p: Vector2) -> void:
	visible = true
	place = solve(type, p, move_id)
	var col := OK_COL if place.valid else BAD_COL
	_mark_mat.albedo_color = Color(col, 0.55)
	_ghost_mat.albedo_color = Color(col.lerp(Color.WHITE, 0.35), 0.85)
	_ghost_mat.emission = col
	_ghost.position = Vector3(place.x, place.y, place.z)
	_ghost.rotation.y = place.rotationY
	_marker.position = Vector3(place.x, 0.03, place.z)
	_stem.position = Vector3(place.x, place.y * 0.5, place.z)
	_stem.scale = Vector3(1, maxf(place.y, 0.01), 1)
	var r: Dictionary = place.room_dict
	_label.text = "%s\n%s" % [Store.room_label(r) if not r.is_empty() else "Outside", place.mount]
	_label.modulate = col.lerp(Color.WHITE, 0.4)
	_label.position = Vector3(place.x, place.y + 0.55, place.z)
	_outline_room(r, col)
	Bus.place_hover.emit({"room": r.get("key", "out"), "roomName": Store.room_label(r), "valid": place.valid, "mount": place.mount})


## Height (y of the device centre) for a type on this map: wall units scaled to the cut-away walls, lights at the
## cut plane, floor units standing on the floor.
static func mount_y(t: String) -> float:
	var size: Vector3 = DeviceNode.BODY.get(t, Vector3(0.2, 0.2, 0.2))
	var h: float = Store.wall_height
	if t == "light":
		return h + size.y * 0.5 + 0.02
	if WALL_Y.has(t):
		var k := minf(h / REAL_STOREY, 1.0)
		var y: float = WALL_Y[t] * k
		return clampf(y, size.y * 0.5 + 0.03, maxf(h - size.y * 0.5 - 0.02, size.y * 0.5 + 0.03))
	return size.y * 0.5


## Where a device of this type goes for a pointer at p (metres): position, facing, room, and whether it may go there.
static func solve(t: String, p: Vector2, skip_id := "") -> Dictionary:
	var r: Dictionary = Store.room_at(p)
	var size: Vector3 = DeviceNode.BODY.get(t, Vector3(0.2, 0.2, 0.2))
	var out := {"x": p.x, "y": mount_y(t), "z": p.y, "rotationY": 0.0, "room": r.get("key", "out"), "room_dict": r, "valid": not r.is_empty(), "mount": "on the floor"}
	if t == "odu":
		out.mount = "outdoor unit"
		var name := Store.room_label(r).to_lower() if not r.is_empty() else ""
		out.valid = r.is_empty() or RegEx.create_from_string(OUTDOOR_ROOMS).search(name) != null
		if not out.valid:
			out.mount = "outdoor units go outside or in a plant room"
		if not r.is_empty():
			out.rotationY = _face_centre(r, p)
		return out
	if r.is_empty():
		out.mount = "outside the floor plan"
		return out
	var poly := PlanGeo.room_poly(r)
	if DOOR.has(t):
		var dd := _near_door(p)
		if not dd.is_empty():
			out.x = dd.pos.x
			out.z = dd.pos.y
			out.rotationY = dd.rot
			out.mount = "beside the door"
			return out
	if WALL.has(t) or DOOR.has(t) or AGAINST_WALL.has(t):
		var w := _on_wall(t, p, poly, size, skip_id)
		if w.is_empty():
			out.valid = false
			out.mount = "no free wall here"
			return out
		out.x = w.pos.x
		out.z = w.pos.y
		out.rotationY = w.rot
		out.mount = "against the wall" if AGAINST_WALL.has(t) else ("on the window wall" if t == "blinds" and w.outside else "on the wall")
		return out
	if t == "light":
		out.mount = "on the ceiling"
	elif t == "leak":
		out.mount = "on the floor (by water)"
	# free-standing: nudge out of furniture and other devices, staying in the room
	var free = _free_spot(p, size, poly, skip_id, t != "light")
	if free == null:
		out.valid = false
		out.mount = "no free floor here"
		return out
	out.x = (free as Vector2).x
	out.z = (free as Vector2).y
	out.rotationY = _face_centre(r, free)
	return out


## A spot on a wall of the room near p: on the wall the pointer is nearest to (or, for blinds, an outside wall
## within 2.5 m), slid along the wall to clear doors, corners, furniture and other devices. {} if none.
static func _on_wall(t: String, p: Vector2, poly: PackedVector2Array, size: Vector3, skip_id: String) -> Dictionary:
	var edges: Array = []
	for k in poly.size():
		var a := poly[k]
		var b := poly[(k + 1) % poly.size()]
		var L := a.distance_to(b)
		if L < size.x + 0.2:
			continue
		var e := (b - a) / L
		var n := Vector2(-e.y, e.x)
		var mid := (a + b) * 0.5
		if not Geometry2D.is_point_in_polygon(mid + n * 0.15, poly):
			n = -n
		var c := Geometry2D.get_closest_point_to_segment(p, a, b)
		var outside := Store.room_at(mid - n * 0.3).is_empty()
		edges.append({"a": a, "b": b, "e": e, "n": n, "L": L, "c": c, "d": c.distance_to(p), "outside": outside})
	if edges.is_empty():
		return {}
	edges.sort_custom(func(x, y): return x.d < y.d)
	if t == "blinds":
		var win := edges.filter(func(x): return x.outside and x.d < 2.5)
		if not win.is_empty():
			edges = win + edges
	for ed in edges.slice(0, 3):
		var u0: float = (ed.c - ed.a).dot(ed.e)
		var margin: float = size.x * 0.5 + 0.12
		# try the pointer's spot, then step outward along the wall both ways
		for step in 31:
			var off := int((step + 1) / 2.0) * 0.15 * (1.0 if step % 2 == 1 else -1.0)
			var u := clampf(u0 + off, margin, ed.L - margin)
			if margin > ed.L - margin:
				break
			var on: Vector2 = ed.a + ed.e * u
			if _near_door_gap(on, ed.e, size.x * 0.5 + 0.1):
				continue
			var back := 0.04 + 0.01 + size.z * 0.5  # half wall + gap + half depth
			var pos: Vector2 = on + ed.n * back
			var rot := atan2(ed.n.x, ed.n.y)
			if _blocked(pos, Vector2(size.x, size.z), rot, skip_id, AGAINST_WALL.has(t)):
				continue
			return {"pos": pos, "rot": rot, "outside": ed.outside}
	return {}


## Is there a door opening within `half` metres along this wall direction?
static func _near_door_gap(on: Vector2, e: Vector2, half: float) -> bool:
	for f in Store.furniture:
		if f.get("kind", "") != "door":
			continue
		var c := Vector2(float(f.x), float(f.z))
		var across := Vector2(cos(float(f.get("rot", 0.0))), -sin(float(f.get("rot", 0.0))))
		if absf(across.dot(e)) < 0.9 or absf((c - on).cross(e)) > 0.3:
			continue
		if absf((c - on).dot(e)) < float(f.w) * 0.5 + half:
			return true
	return false


## Nearest free spot for a footprint near p, inside the room (spiral search up to 2.5 m). null if none.
static func _free_spot(p: Vector2, size: Vector3, poly: PackedVector2Array, skip_id: String, floor_level: bool) -> Variant:
	var fp := Vector2(size.x, size.z)
	for ring in 18:
		var rad := ring * 0.15
		var n := 1 if ring == 0 else 8 + ring * 2
		for i in n:
			var a := TAU * i / n
			var q := p + Vector2(cos(a), sin(a)) * rad
			if not _inside(q, fp, poly):
				continue
			if not _blocked(q, fp, 0.0, skip_id, floor_level):
				return q
	return null


static func _inside(q: Vector2, fp: Vector2, poly: PackedVector2Array) -> bool:
	var hx := fp.x * 0.5 + 0.06
	var hz := fp.y * 0.5 + 0.06
	for c in [q, q + Vector2(hx, hz), q + Vector2(-hx, hz), q + Vector2(hx, -hz), q + Vector2(-hx, -hz)]:
		if not Geometry2D.is_point_in_polygon(c, poly):
			return false
	return true


## Does a footprint (centre, size along/across, rotation) overlap furniture (when on the floor) or another device?
static func _blocked(q: Vector2, fp: Vector2, rot: float, skip_id: String, floor_level: bool) -> bool:
	var mine := _rect(q, fp, rot)
	if floor_level:
		for f in Store.furniture:
			var k: String = f.get("kind", "")
			if k == "door" or k == "rug" or k == "railing":
				continue
			if _overlap(mine, _rect(Vector2(float(f.x), float(f.z)), Vector2(float(f.w), float(f.d)), float(f.get("rot", 0.0)))):
				return true
	for d in Store.devices:
		if d.id == skip_id or d.id == "Ghost":
			continue
		var ds: Vector3 = DeviceNode.BODY.get(d.type, Vector3(0.2, 0.2, 0.2))
		var dp := Vector2(float(d.position[0]), float(d.position[2]))
		if dp.distance_to(q) < (maxf(ds.x, ds.z) + maxf(fp.x, fp.y)) * 0.5 + 0.05:
			if not floor_level or not WALL.has(d.type):
				return true
	return false


static func _rect(c: Vector2, sz: Vector2, rot: float) -> PackedVector2Array:
	var u := Vector2(cos(rot), -sin(rot)) * sz.x * 0.5
	var v := Vector2(sin(rot), cos(rot)) * sz.y * 0.5
	return PackedVector2Array([c - u - v, c + u - v, c + u + v, c - u + v])


static func _overlap(a: PackedVector2Array, b: PackedVector2Array) -> bool:
	return not Geometry2D.intersect_polygons(a, b).is_empty()


static func _face_centre(r: Dictionary, p: Vector2) -> float:
	var c := PlanGeo.interior_point(PlanGeo.room_poly(r))
	return atan2(c.x - p.x, c.y - p.y) if c.distance_to(p) > 0.2 else 0.0


## Nearest door within 3 m: a spot beside its opening, on the pointer's side, facing that side.
static func _near_door(p: Vector2) -> Dictionary:
	var best := {}
	var bd := 3.0
	for f in Store.furniture:
		if f.get("kind", "") != "door":
			continue
		var c := Vector2(f.x, f.z)
		var dist := c.distance_to(p)
		if dist < bd:
			bd = dist
			var rot: float = f.get("rot", 0.0)
			var along := Vector2(cos(rot), -sin(rot))     # the wall line through the door (item local x)
			var normal := Vector2(sin(rot), cos(rot))     # item local z
			var side := 1.0 if (p - c).dot(normal) >= 0 else -1.0
			var pos: Vector2 = c + along * (float(f.w) * 0.5 + 0.12) + normal * side * 0.08
			best = {"pos": pos, "rot": atan2(normal.x * side, normal.y * side)}
	return best


func _outline_room(r: Dictionary, col: Color) -> void:
	var key: String = str(r.get("key", "")) + str(col)
	if key == _outline_key:
		return
	_outline_key = key
	for c in _outline.get_children():
		c.queue_free()
	if r.is_empty():
		return
	var poly := PlanGeo.room_poly(r)
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.albedo_color = col
	m.emission_enabled = true
	m.emission = col
	var fill := StandardMaterial3D.new()
	fill.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	fill.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	fill.albedo_color = Color(col, 0.14)
	fill.cull_mode = BaseMaterial3D.CULL_DISABLED
	for k in poly.size():
		var a := poly[k]
		var b := poly[(k + 1) % poly.size()]
		var seg := MeshInstance3D.new()
		var bm := BoxMesh.new()
		bm.size = Vector3(a.distance_to(b) + 0.08, 0.04, 0.08)
		seg.mesh = bm
		seg.material_override = m
		_outline.add_child(seg)
		seg.position = Vector3((a.x + b.x) * 0.5, 0.05, (a.y + b.y) * 0.5)
		seg.rotation.y = -atan2(b.y - a.y, b.x - a.x)
	var tris := Geometry2D.triangulate_polygon(poly)
	if tris.is_empty():
		return
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for i in tris:
		st.add_vertex(Vector3(poly[i].x, 0.035, poly[i].y))
	var mi := MeshInstance3D.new()
	mi.mesh = st.commit()
	mi.material_override = fill
	_outline.add_child(mi)


## A ring that spreads out where a device was put down.
func _splash(at: Vector3) -> void:
	var host := get_parent()
	var ring := MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = 0.25
	tm.outer_radius = 0.3
	ring.mesh = tm
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.albedo_color = Color(OK_COL, 0.9)
	ring.material_override = m
	host.add_child(ring)
	ring.position = at
	var tw := ring.create_tween().set_parallel()
	tw.tween_property(ring, "scale", Vector3.ONE * 5.0, 0.8).set_ease(Tween.EASE_OUT)
	tw.tween_property(m, "albedo_color:a", 0.0, 0.8)
	tw.chain().tween_callback(ring.queue_free)


## Moving a placed device happens inside the 3D view: the pointer is ours.
func _input(e: InputEvent) -> void:
	if not active() or move_id == "":
		return
	if e is InputEventMouseMotion:
		_update(e.position)
	elif e is InputEventMouseButton and e.pressed and e.button_index == MOUSE_BUTTON_LEFT:
		_update(e.position)
		finish(true)
		get_viewport().set_input_as_handled()
	elif (e is InputEventMouseButton and e.pressed and e.button_index == MOUSE_BUTTON_RIGHT) or e.is_action_pressed("back"):
		cancel()
		get_viewport().set_input_as_handled()
