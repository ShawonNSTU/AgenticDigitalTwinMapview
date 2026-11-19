class_name Placer
extends Node3D
## Places SmartThings devices on the floor: a device dragged from the host page's palette (dragStart /
## dragMove / dragEnd with the pointer in 0..1 viewport coordinates), or a placed device being moved
## (startMove, then the pointer inside the 3D view; click to put it down, Esc to cancel).
##
## While dragging, a see-through copy of the device follows the pointer and snaps the way that type is
## installed: wall units (AC, TV, camera, sensors, plug) go flat on the nearest wall of the room, facing
## in; door lock and doorbell go beside the nearest door; floor units stand where they are dropped, facing
## the room; lights go on the ceiling. The room under the pointer is outlined, green if the device can go
## there, red if not. On drop the renderer reports the placement to the host, which adds it to the platform.

const MOUNT := {"ac": 2.15, "odu": 0.35, "light": 2.6, "tv": 1.2, "speaker": 0.55, "blinds": 1.7, "fridge": 0.9, "oven": 0.45,
	"vacuum": 0.06, "camera": 2.2, "doorbell": 1.3, "lock": 1.0, "washer": 0.45, "dryer": 0.45, "leak": 0.02, "temphum": 1.5,
	"motion": 2.2, "plug": 0.35, "purifier": 0.3}
const WALL := ["ac", "tv", "blinds", "camera", "temphum", "motion", "plug"]
const DOOR := ["lock", "doorbell"]
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
	if not MOUNT.has(new_type):
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


## Pointer (viewport pixels) -> point on the floor.
func _update(screen: Vector2) -> void:
	if rig == null or rig.cam == null:
		return
	var o := rig.cam.project_ray_origin(screen)
	var dir := rig.cam.project_ray_normal(screen)
	if absf(dir.y) < 1e-4:
		return
	var t := -o.y / dir.y
	if t < 0:
		visible = false
		return
	var hit := o + dir * t
	_update_at(Vector2(hit.x, hit.z))


func _update_at(p: Vector2) -> void:
	visible = true
	place = solve(type, p)
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


## Where a device of this type goes for a pointer at p (metres): position, facing, room, and whether it may go there.
static func solve(t: String, p: Vector2) -> Dictionary:
	var r: Dictionary = Store.room_at(p)
	var y: float = MOUNT.get(t, 1.0)
	var size: Vector3 = DeviceNode.BODY.get(t, Vector3(0.2, 0.2, 0.2))
	var out := {"x": p.x, "y": y, "z": p.y, "rotationY": 0.0, "room": r.get("key", "out"), "room_dict": r, "valid": not r.is_empty(), "mount": "on the floor"}
	if t == "odu":
		out.valid = true  # outdoor units go outside the rooms (or in a plant room)
		out.mount = "outdoor unit"
		out.y = size.y * 0.5
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
	if WALL.has(t) or DOOR.has(t):
		var best := INF
		var q := p
		var n := Vector2.ZERO
		for k in poly.size():
			var a := poly[k]
			var b := poly[(k + 1) % poly.size()]
			var c := Geometry2D.get_closest_point_to_segment(p, a, b)
			var dist := c.distance_to(p)
			if dist < best and a.distance_to(b) > 0.3:
				best = dist
				q = c
				var e := (b - a).normalized()
				n = Vector2(-e.y, e.x)
				if not Geometry2D.is_point_in_polygon(c + n * 0.15, poly):
					n = -n
		# keep clear of corners so the unit sits on the wall, not across two walls
		var pos := q + n * (0.1 + size.z * 0.5)
		out.x = pos.x
		out.z = pos.y
		out.rotationY = atan2(n.x, n.y)
		out.mount = "on the wall"
		return out
	if t == "light":
		out.mount = "on the ceiling"
	elif t == "leak":
		out.mount = "on the floor (by water)"
	out.y = maxf(y, size.y * 0.5)
	out.rotationY = _face_centre(r, p)
	return out


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
