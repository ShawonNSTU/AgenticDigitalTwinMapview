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


## Keeps the walker inside one room from now on (a guest who reached their room).
func confine(r: Dictionary) -> void:
	if r.is_empty():
		return
	nav.restrict(PlanGeo.room_poly(r))


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
		if nav.is_free(q):
			p = q
		elif nav.is_free(Vector2(q.x, p.y)):
			p.x = q.x
			blocked = true
		elif nav.is_free(Vector2(p.x, q.y)):
			p.y = q.y
			blocked = true
		else:
			blocked = true
			break
	if blocked and _path.size() > 0 and _path[0].distance_to(p) > 0.3 and not nav.line_free(p, _path[0]):
		go_to(_path[_path.size() - 1])  # pushed off the route: plan again from here


func _apply() -> void:
	var bob := sin(_bob) * 0.02
	var t := Transform3D(Basis(Vector3.UP, yaw) * Basis(Vector3.RIGHT, pitch), Vector3(p.x, eye + bob, p.y))
	if _intro > 0.0:
		var a := 1.0 - _intro / INTRO
		cam.global_transform = _from.interpolate_with(t, a * a * (3.0 - 2.0 * a))
	else:
		cam.global_transform = t


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
	if _intro > 0.4:
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
			plate.pixel_size = 0.0035
			plate.width = 900
			plate.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			plate.double_sided = false
			plate.modulate = Color(0.1, 0.13, 0.2)
			plate.outline_size = 8
			plate.outline_modulate = Color(1, 1, 1, 0.9)
			var at: Vector2 = c + n * side * 0.07
			plate.position = Vector3(at.x, LINTEL + minf(0.22, (Store.wall_height - LINTEL) / 2), at.y)
			plate.rotation.y = atan2(n.x * side, n.y * side)
			add_child(plate)
