class_name Walker
extends Node3D
## First-person walk-through at eye height. Walls, columns and furniture block the way; rooms are entered
## through their doorways. Click (or tap) the floor to walk there along an A* route, drag to look around,
## or move with W A S D / arrows, the wheel, a two-finger pinch or the host page's on-screen stick.

const EYE := 1.6
const SPEED := 1.4   # m/s
const RUN := 2.8
const ROUTE := 1.8   # m/s when following a clicked route
const LOOK := 0.0045  # radians of turn per pixel dragged
const LINTEL := 2.08  # top of a door opening
const INTRO := 1.3

signal arrived  # a route (click, room or guest walk) has ended
signal landed   # the drop from the map view to eye height has finished

var cam: Camera3D
var nav := WalkNav.new()
var p := Vector2.ZERO  # position on the floor (x, z)
var yaw := 0.0         # 0 looks towards -z, same as the map camera's yaw
var pitch := deg_to_rad(-4.0)
var joy := Vector2.ZERO  # host stick: x turns (right = +1), y walks (up = -1)
var eye := EYE
var room_key := "~"

var _pieces: Array = []   # wall pieces [a, b] (door gaps left out)
var _lintels: Array = []  # [a, b] over each door gap, LINTEL .. wall height
var _keys := {}
var _path := PackedVector2Array()
var _push := 0.0          # metres still to step from the wheel or a pinch
var _moved := 0.0         # pixels dragged since the button went down
var _down := false
var _touches := {}
var _multi := false
var _spread := 0.0
var _bob := 0.0
var _intro := 0.0
var _from: Transform3D
var _hover: MeshInstance3D
var _goal: MeshInstance3D
var _room_in := 0.0


func begin(pieces: Array, lintels: Array, start: Vector2, start_yaw: float, from: Transform3D) -> void:
	_pieces = pieces
	_lintels = lintels
	nav.build(pieces, lintels)
	eye = minf(EYE, Store.wall_height - 0.5)
	p = nav.nearest_free(start, 200)
	yaw = start_yaw
	cam = Camera3D.new()
	cam.fov = 72.0
	cam.near = 0.05
	cam.far = 500.0
	add_child(cam)
	cam.current = true
	_from = from
	_intro = INTRO
	_rings()
	_door_signs()
	_apply()


## Walk to a floor point along the shortest route through doorways.
func go_to(target: Vector2) -> bool:
	_path = nav.path(p, target)
	_push = 0.0
	if _path.is_empty():
		_goal.visible = false
		return false
	var end := _path[_path.size() - 1]
	_goal.position = Vector3(end.x, 0.02, end.y)
	_goal.visible = true
	return true


var live := false          # following live position fixes instead of a planned walk
var _you: Node3D           # "you are here" marker with the fix's accuracy circle
var _you_acc: MeshInstance3D
var _you_label: Label3D
var _route_node: Node3D
var _over := false
var _over_from: Transform3D
var _over_t := 1.0  # 0..1 progress of the move into or out of the overview
var _look_goal = null  # [yaw, pitch] to turn to (guided tour)


func set_live(on: bool) -> void:
	live = on
	if on:
		_cancel_route()
	if _you == null:
		_you = Node3D.new()
		add_child(_you)
		_you_acc = MeshInstance3D.new()
		var cm := CylinderMesh.new()
		cm.top_radius = 1.0
		cm.bottom_radius = 1.0
		cm.height = 0.01
		cm.radial_segments = 40
		_you_acc.mesh = cm
		var m := StandardMaterial3D.new()
		m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		m.albedo_color = Color(0.15, 0.5, 1.0, 0.18)
		_you_acc.material_override = m
		_you_acc.position.y = 0.02
		_you.add_child(_you_acc)
		var dot := MeshInstance3D.new()
		var sm := SphereMesh.new()
		sm.radius = 0.16
		sm.height = 0.32
		dot.mesh = sm
		var dm := StandardMaterial3D.new()
		dm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		dm.albedo_color = Color("2563eb")
		dot.material_override = dm
		dot.position.y = 0.2
		_you.add_child(dot)
		_you_label = Label3D.new()
		_you_label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		_you_label.fixed_size = true
		_you_label.no_depth_test = true
		_you_label.pixel_size = 0.0007
		_you_label.font_size = 24
		_you_label.outline_size = 8
		_you_label.modulate = Color("93c5fd")
		_you_label.position.y = 0.7
		_you.add_child(_you_label)
	_you.visible = on


## A live fix (already snapped to walkable floor): the view walks there along the floor, never through walls.
func live_fix(q: Vector2, accuracy: float, source: String) -> void:
	if not live:
		return
	_you.position = Vector3(q.x, 0, q.y)
	_you_acc.scale = Vector3(clampf(accuracy, 0.4, 15.0), 1, clampf(accuracy, 0.4, 15.0))
	_you_label.text = "You are here · ±%.0f m · %s" % [accuracy, {"rtls": "positioning badge", "rtls-sim": "badge (simulated)", "checkpoint": "location code", "pdr": "step tracking"}.get(source, source)]
	if q.distance_to(p) > 8.0 or (_path.is_empty() and q.distance_to(p) > 0.35):
		if q.distance_to(p) > 8.0:
			teleport(q)  # a far jump (first fix, or a checkpoint): go there directly
		else:
			go_to(q)
	elif not _path.is_empty():
		go_to(q)


## A guide line on the floor from the start to the destination (chevrons pointing the way) with tags where
## the way enters another room (corridor, stairs, lift...) and at the destination.
func show_route(start: Vector2, route: PackedVector2Array, dest: String) -> void:
	if _route_node:
		_route_node.queue_free()
	_route_node = Node3D.new()
	add_child(_route_node)
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.albedo_color = Color(0.2, 0.55, 1.0, 0.85)
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	var chev := PrismMesh.new()
	chev.size = Vector3(0.32, 0.36, 0.01)
	var pts := PackedVector2Array([start]) + route
	var room_before := Store.room_label(Store.room_at(start))
	var carry := 0.0
	for i in pts.size() - 1:
		var a := pts[i]
		var b := pts[i + 1]
		var len := a.distance_to(b)
		var d := (b - a) / maxf(len, 0.001)
		var t := carry
		while t < len:
			var q := a + d * t
			var m := MeshInstance3D.new()
			m.mesh = chev
			m.material_override = mat
			m.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			m.position = Vector3(q.x, 0.025, q.y)
			m.rotation = Vector3(-PI / 2, atan2(-d.x, -d.y), 0)
			_route_node.add_child(m)
			t += 0.9
		carry = t - len
		var here := Store.room_label(Store.room_at(b))
		if here != room_before and i < pts.size() - 2:
			_route_tag(b, here, Color(0.75, 0.85, 1.0))
			room_before = here
	_route_tag(pts[pts.size() - 1], dest, Color(0.45, 0.85, 0.55))
	_beacon(pts[pts.size() - 1])


var _beacon_node: Node3D


## A pulsing marker over the destination, seen through walls, so the guest always knows where the room is.
func _beacon(at: Vector2) -> void:
	_beacon_node = Node3D.new()
	_beacon_node.position = Vector3(at.x, 0, at.y)
	_route_node.add_child(_beacon_node)
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.albedo_color = Color(0.3, 0.9, 0.55, 0.85)
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.no_depth_test = true
	m.render_priority = 2
	var gem := MeshInstance3D.new()
	var pm := PrismMesh.new()
	pm.size = Vector3(0.32, 0.4, 0.32)
	gem.mesh = pm
	gem.material_override = m
	gem.rotation.z = PI  # point down at the room
	gem.position.y = 2.35
	_beacon_node.add_child(gem)
	var ring := MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = 0.45
	tm.outer_radius = 0.55
	ring.mesh = tm
	var rm := m.duplicate() as StandardMaterial3D
	rm.no_depth_test = false
	ring.material_override = rm
	ring.scale = Vector3(1, 0.1, 1)
	ring.position.y = 0.03
	_beacon_node.add_child(ring)


func _route_tag(at: Vector2, text: String, col: Color) -> void:
	var l := Label3D.new()
	l.text = text
	l.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	l.fixed_size = true
	l.pixel_size = 0.0007
	l.font_size = 24
	l.outline_size = 8
	l.outline_modulate = Color(0.05, 0.07, 0.1, 0.9)
	l.modulate = col
	l.no_depth_test = true
	l.position = Vector3(at.x, 1.9, at.y)
	_route_node.add_child(l)


func hide_route() -> void:
	if _route_node:
		_route_node.queue_free()
		_route_node = null


## The way from above (the guest's overview); again to come back down.
func overview(on: bool) -> void:
	if on == _over:
		return
	_over = on
	_over_t = 0.0
	_over_from = cam.global_transform
	var fb := FloorBuilder.current
	if fb and fb.ceilings:
		fb.ceilings.visible = not on


## Turn to face a point (guided tour of the room's devices).
func look_at_point(q: Vector3) -> void:
	var eye_pos := Vector3(p.x, eye, p.y)
	var d := q - eye_pos
	var flat := Vector2(d.x, d.z).length()
	_look_goal = [atan2(-d.x, -d.z), clampf(atan2(d.y, flat), deg_to_rad(-60.0), deg_to_rad(50.0))]
	_cancel_route()


## Keeps the walker inside one room from now on (a guest who reached their room).
var _confine := PackedVector2Array()


func confine(r: Dictionary) -> void:
	if r.is_empty():
		return
	_confine = PlanGeo.room_poly(r)
	nav.restrict(_confine)


## Walkable for the body here: a free cell and, once confined, inside the room outline itself.
func _ok(q: Vector2) -> bool:
	return nav.is_free(q) and (_confine.is_empty() or Geometry2D.is_point_in_polygon(q, _confine))


func teleport(q: Vector2) -> void:
	_cancel_route()
	var from := cam.global_transform
	p = nav.nearest_free(q, 40)
	var c := PlanGeo.interior_point(PlanGeo.room_poly(Store.room_at(p))) if not Store.room_at(p).is_empty() else p
	if c.distance_to(p) > 0.3:
		yaw = atan2(-(c - p).x, -(c - p).y)
	_from = from
	_intro = INTRO


func go_to_room(key: String) -> bool:
	var r: Dictionary = Store.room(key)
	if r.is_empty():
		return false
	var target := nav.room_target(r, p)
	return target != Vector2.INF and go_to(target)


func _process(delta: float) -> void:
	delta = minf(delta, 0.25)
	if _beacon_node and is_instance_valid(_beacon_node):
		var k := 1.0 + 0.15 * sin(Time.get_ticks_msec() / 250.0)
		_beacon_node.get_child(0).position.y = 2.35 + 0.08 * sin(Time.get_ticks_msec() / 400.0)
		_beacon_node.get_child(1).scale = Vector3(k, 0.1, k)
	if _intro > 0.0 and _intro - delta <= 0.0:
		landed.emit()
	_intro = maxf(0.0, _intro - delta)
	var k := func(code: int) -> float: return 1.0 if _keys.get(code, false) else 0.0
	var move: Vector2 = Vector2(k.call(KEY_D) - k.call(KEY_A), k.call(KEY_W) + k.call(KEY_UP) - k.call(KEY_S) - k.call(KEY_DOWN) - joy.y)
	var turn: float = k.call(KEY_LEFT) + k.call(KEY_Q) - k.call(KEY_RIGHT) - k.call(KEY_E) - joy.x
	var fwd := Vector2(-sin(yaw), -cos(yaw))
	var right := Vector2(cos(yaw), -sin(yaw))
	var vel := Vector2.ZERO
	if move.length() > 0.05 or absf(turn) > 0.05:
		_cancel_route()
	yaw += turn * 1.7 * delta
	if move.length() > 0.05:
		vel = (fwd * move.y + right * move.x).limit_length(1.0) * (RUN if Input.is_key_pressed(KEY_SHIFT) else SPEED)
	elif absf(_push) > 0.001:
		var s := signf(_push) * minf(absf(_push), RUN * delta)
		_push -= s
		vel = fwd * s / delta
	elif _path.size() > 0:
		var to := _path[0] - p
		if to.length() < 0.1:
			_path.remove_at(0)
			if _path.is_empty():
				_goal.visible = false
				_track_room()
				arrived.emit()
		else:
			vel = to.normalized() * minf(ROUTE, to.length() / delta)
			if not _down and _touches.is_empty():  # look where you walk unless the user is looking around
				yaw = lerp_angle(yaw, atan2(-to.x, -to.y), 1.0 - exp(-5.0 * delta))
				pitch = lerpf(pitch, deg_to_rad(-4.0), 1.0 - exp(-3.0 * delta))
	if vel != Vector2.ZERO:
		var before := p
		_step(vel * delta)
		_unstick(before, vel.length() * delta, delta)
		_bob += vel.length() * delta * 6.5
	_apply()
	_room_in -= delta
	if _room_in <= 0.0:
		_room_in = 0.2
		_track_room()


var _stuck := 0.0


## Following a route but not getting anywhere (a corner the body can't round): plan again; right next to
## the end, call it arrived.
func _unstick(before: Vector2, wanted: float, delta: float) -> void:
	if _path.is_empty() or wanted < 1e-4:
		_stuck = 0.0
		return
	_stuck = _stuck + delta if before.distance_to(p) < wanted * 0.25 else 0.0
	if _stuck < 0.6:
		return
	_stuck = 0.0
	var end := _path[_path.size() - 1]
	if end.distance_to(p) < 0.7:
		_cancel_route()
		_track_room()
		arrived.emit()
	else:
		go_to(end)


## Moves with collision, in small steps so nothing is skipped at low frame rates; slides along walls.
func _step(d: Vector2) -> void:
	var n := maxi(1, ceili(d.length() / (nav.cell * 0.5)))
	var s := d / n
	var blocked := false
	for i in n:
		var q := p + s
		if _ok(q):
			p = q
		elif _ok(Vector2(q.x, p.y)):
			p.x = q.x
			blocked = true
		elif _ok(Vector2(p.x, q.y)):
			p.y = q.y
			blocked = true
		else:
			blocked = true
			break
	if blocked and _path.size() > 0 and _path[0].distance_to(p) > 0.3 and not nav.line_free(p, _path[0]):
		go_to(_path[_path.size() - 1])  # pushed off the route: plan again from here


func _apply() -> void:
	if _look_goal != null:
		yaw = lerp_angle(yaw, _look_goal[0], 0.12)
		pitch = lerpf(pitch, _look_goal[1], 0.12)
		if absf(wrapf(yaw - _look_goal[0], -PI, PI)) < 0.01 and absf(pitch - _look_goal[1]) < 0.01:
			_look_goal = null
	var bob := sin(_bob) * 0.02
	var t := Transform3D(Basis(Vector3.UP, yaw) * Basis(Vector3.RIGHT, pitch), Vector3(p.x, eye + bob, p.y))
	if _over or _over_t < 1.0:
		_over_t = minf(_over_t + get_process_delta_time() / 1.2, 1.0)
		var top := _overview_xform()
		var a := _over_t * _over_t * (3.0 - 2.0 * _over_t)
		cam.global_transform = (_over_from.interpolate_with(top, a)) if _over else _over_from.interpolate_with(t, a)
		return
	if _intro > 0.0:
		var a := 1.0 - _intro / INTRO
		cam.global_transform = _from.interpolate_with(t, a * a * (3.0 - 2.0 * a))
	else:
		cam.global_transform = t


## Straight down over the walker and the way to the destination.
func _overview_xform() -> Transform3D:
	var box := Rect2(p, Vector2.ZERO)
	if _route_node:
		for c in _route_node.get_children():
			box = box.expand(Vector2(c.position.x, c.position.z))
	box = box.grow(3.0)
	var h := maxf(box.size.x, box.size.y) / (2.0 * tan(deg_to_rad(cam.fov) / 2.0)) + 4.0
	var c := box.get_center()
	return Transform3D(Basis(Vector3.RIGHT, -PI / 2 + 0.001), Vector3(c.x, h, c.y))


func _track_room() -> void:
	var r: Dictionary = Store.room_at(p)
	var key: String = r.get("key", "out")
	if key != room_key:
		room_key = key
		Bus.walk_changed.emit({"on": true, "room": key, "roomName": Store.room_label(r)})


func _cancel_route() -> void:
	_path = PackedVector2Array()
	_push = 0.0
	if _goal:
		_goal.visible = false


func _look(rel: Vector2) -> void:
	# grab the view: dragging right swings the scene right (the head turns left)
	yaw += rel.x * LOOK
	pitch = clampf(pitch + rel.y * LOOK, deg_to_rad(-70.0), deg_to_rad(60.0))


func _unhandled_input(e: InputEvent) -> void:
	if _intro > 0.4 or _over:
		return
	if e is InputEventMouseButton:
		if e.device == InputEvent.DEVICE_ID_EMULATION:
			return
		match e.button_index:
			MOUSE_BUTTON_LEFT, MOUSE_BUTTON_RIGHT:
				if e.pressed:
					_down = true
					_moved = 0.0
				else:
					_down = false
					if e.button_index == MOUSE_BUTTON_LEFT and _moved < 6.0:
						_walk_to_screen(e.position)
			MOUSE_BUTTON_WHEEL_UP:
				if e.pressed:
					_path = PackedVector2Array()
					_push += 0.5 * maxf(e.factor, 1.0)
			MOUSE_BUTTON_WHEEL_DOWN:
				if e.pressed:
					_path = PackedVector2Array()
					_push -= 0.5 * maxf(e.factor, 1.0)
	elif e is InputEventMouseMotion:
		if e.device == InputEvent.DEVICE_ID_EMULATION:
			return
		if e.button_mask & (MOUSE_BUTTON_MASK_LEFT | MOUSE_BUTTON_MASK_RIGHT):
			_moved += e.relative.length()
			_look(e.relative)
		else:
			_down = false
			_hover_at(e.position)
	elif e is InputEventScreenTouch:
		_touch(e)
	elif e is InputEventScreenDrag:
		_touch_drag(e)
	elif e is InputEventKey and not e.echo:
		_keys[e.physical_keycode] = e.pressed
		if e.keycode != e.physical_keycode:
			_keys[e.keycode] = e.pressed


func _touch(e: InputEventScreenTouch) -> void:
	if e.pressed:
		_touches[e.index] = {"pos": e.position, "moved": 0.0}
		if _touches.size() >= 2:
			_multi = true
			_spread = _finger_spread()
	else:
		var t = _touches.get(e.index)
		_touches.erase(e.index)
		if t != null and _touches.is_empty() and not _multi and t.moved < 12.0:
			_walk_to_screen(e.position)
		if _touches.is_empty():
			_multi = false
		elif _touches.size() >= 2:
			_spread = _finger_spread()


func _touch_drag(e: InputEventScreenDrag) -> void:
	if not _touches.has(e.index):
		return
	_touches[e.index].moved += e.relative.length()
	_touches[e.index].pos = e.position
	if _touches.size() == 1 and not _multi:
		_look(e.relative)
	elif _touches.size() == 2:
		var s := _finger_spread()
		_path = PackedVector2Array()
		_push += (s - _spread) * 0.012  # spreading the fingers walks forward, pinching walks back
		_spread = s


func _finger_spread() -> float:
	var ps: Array = _touches.values().map(func(t): return t.pos)
	return (ps[0] as Vector2).distance_to(ps[1]) if ps.size() >= 2 else 0.0


func _walk_to_screen(screen: Vector2) -> void:
	var hit = floor_at(screen)
	if hit != null:
		go_to(hit)


## Floor point under the pointer, seen from the walker's eye: walls and lintels stop the ray, door gaps
## let it through, so clicking through a doorway walks into the next room.
func floor_at(screen: Vector2) -> Variant:
	var o := cam.project_ray_origin(screen)
	var dir := cam.project_ray_normal(screen)
	var best := INF
	if dir.y < -1e-4:
		best = -o.y / dir.y
	var near := Vector2.ZERO
	var h: float = Store.wall_height
	for layer in [[_pieces, 0.0], [_lintels, LINTEL]]:
		for s in layer[0]:
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
			if q.y < layer[1] or q.y > h:
				continue
			var along := (Vector2(q.x, q.z) - a).dot(e) / e.length_squared()
			if along < 0.0 or along > 1.0:
				continue
			best = t
			near = (n if denom < 0.0 else -n) * 0.3
	if best == INF or best > 200.0:
		return null
	var hit := o + dir * best
	return Vector2(hit.x, hit.z) + near


func _hover_at(screen: Vector2) -> void:
	var hit = floor_at(screen)
	_hover.visible = hit != null and nav.is_free(hit)
	if _hover.visible:
		_hover.position = Vector3(hit.x, 0.015, hit.y)


func _rings() -> void:
	for i in 2:
		var m := MeshInstance3D.new()
		var tm := TorusMesh.new()
		tm.inner_radius = 0.2 if i == 0 else 0.26
		tm.outer_radius = 0.25 if i == 0 else 0.34
		tm.rings = 32
		m.mesh = tm
		m.scale = Vector3(1, 0.08, 1)
		var mat := StandardMaterial3D.new()
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		mat.albedo_color = Color(1, 1, 1, 0.75) if i == 0 else Color(0.15, 0.45, 0.95, 0.9)
		m.material_override = mat
		m.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		m.visible = false
		add_child(m)
		if i == 0:
			_hover = m
		else:
			_goal = m


## A name sign over each doorway, on both faces: the room you are about to enter.
func _door_signs() -> void:
	for f in Store.furniture:
		if f.get("kind", "") != "door":
			continue
		var c := Vector2(float(f.x), float(f.z))
		var rot := float(f.get("rot", 0.0))
		var n := Vector2(sin(rot), cos(rot))  # across the wall
		for side in [1.0, -1.0]:
			var here: Dictionary = Store.room_at(c + n * side * 0.45)
			var there: Dictionary = Store.room_at(c - n * side * 0.45)
			if there.is_empty() or here == there:
				continue
			var plate := Label3D.new()
			plate.text = Store.room_label(there)
			plate.font_size = 40
			plate.pixel_size = 0.0022
			plate.width = 700
			plate.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			plate.double_sided = false
			plate.modulate = Color(0.1, 0.13, 0.2)
			plate.outline_size = 8
			plate.outline_modulate = Color(1, 1, 1, 0.9)
			var at: Vector2 = c + n * side * 0.07
			plate.position = Vector3(at.x, LINTEL + minf(0.22, (Store.wall_height - LINTEL) / 2), at.y)
			plate.rotation.y = atan2(n.x * side, n.y * side)
			add_child(plate)
