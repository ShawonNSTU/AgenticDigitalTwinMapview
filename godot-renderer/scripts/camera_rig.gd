class_name CameraRig
extends Node3D
## Orbit camera sized to the floor.
##
## Mouse: left-drag orbit, right/middle-drag pan, wheel zooms toward the point under the cursor.
## Touch: one finger orbits, two fingers pinch-zoom and pan.
## Keys: arrows/WASD pan, +/- zoom, Q/E rotate, F fit the floor, T top view, Home reset.
##
## set_bounds() takes the floor's extent; the zoom range, the far plane, the pan limits and the "fit" distance all
## follow from it and from the window's shape, so any plan (a 10 m flat or a 120 m office floor) fits on screen
## and can be zoomed out to see the whole of it. Zoom and pan are damped toward goals for smooth motion.
## fly_to() animates target, distance and angles together.

const PITCH_MIN := -89.0   # degrees: straight down
const PITCH_MAX := -6.0
const MIN_DISTANCE := 0.4  # close enough for the smallest twin part

var target := Vector3(-2.5, 0, -3.5)
var yaw := deg_to_rad(-30.0)
var pitch := deg_to_rad(-52.0)
var distance := 19.0
var cam: Camera3D

## Floor extent on the ground plane (x, z) and the limits derived from it.
var bounds := Rect2(-10, -10, 20, 20)
var max_distance := 60.0

var _goal_distance := 19.0
var _goal_target := Vector3.ZERO
var _home := {}
var _drag := 0
var _tw: Tween
var _touches := {}
var _pinch := 0.0
var _keys := Vector3.ZERO

## Pixels moved during the current/last mouse drag; device clicks ignore drags.
static var drag_px := 0.0


func _ready() -> void:
	cam = Camera3D.new()
	cam.fov = 45
	cam.near = 0.05
	cam.far = 400
	add_child(cam)
	_goal_distance = distance
	_goal_target = target
	_home = {"target": target, "yaw": yaw, "pitch": pitch, "distance": distance}
	get_viewport().size_changed.connect(_on_resize)
	_apply()


## The floor's extent (x, z). Sets the zoom range and pan limits, and the home view to a fit of the whole floor.
func set_bounds(rect: Rect2) -> void:
	bounds = rect.abs()
	if bounds.size.x < 1.0 or bounds.size.y < 1.0:
		bounds = bounds.grow(5.0)
	var fit := fit_distance(deg_to_rad(-52.0), deg_to_rad(-30.0))
	max_distance = maxf(fit * 2.5, 30.0)
	cam.far = maxf(400.0, max_distance * 4.0)
	_home.target = fit_target(fit, deg_to_rad(-52.0), deg_to_rad(-30.0))
	_home.distance = fit
	_home.pitch = deg_to_rad(-52.0)
	_home.yaw = deg_to_rad(-30.0)
	user_moved = false
	jump(_home.target, _home.distance, _home.pitch, _home.yaw)


## Screen space covered by the host page's overlays (palette, toolbar, navigation), in pixels. The page measures
## and sends them (bridge "setInsets"); fits keep the floor clear of them. A small margin is always added.
var insets_px := {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0}
var fit_margins: Dictionary:
	get:
		var vp := get_viewport().get_visible_rect().size
		var m := {}
		for k in ["left", "right", "top", "bottom"]:
			var span := vp.x if k == "left" or k == "right" else vp.y
			m[k] = clampf(float(insets_px[k]) / maxf(span, 1.0) + 0.04, 0.0, 0.45)
		return m
## The user has moved the view since the last automatic fit: resizes and new insets no longer re-fit.
var user_moved := false
const WALL_TOP := 3.0


## Distance at which the whole floor (walls included) fits inside the view margins at the given pitch and the
## current yaw. Found by bisection on the projected floor corners, so it is exact for any angle and window shape.
func fit_distance(p: float = NAN, y: float = NAN) -> float:
	if is_nan(p):
		p = pitch
	if is_nan(y):
		y = yaw
	var vp := get_viewport().get_visible_rect().size
	if vp.x < 2.0 or vp.y < 2.0:
		return maxf(bounds.size.length(), 6.0)
	var lo := 0.5
	var hi := maxf(bounds.size.length() * 6.0, 20.0)
	var keep := cam.global_transform
	var centre := Vector3(bounds.get_center().x, 0, bounds.get_center().y)
	var corners: Array[Vector3] = []
	for c in [bounds.position, Vector2(bounds.end.x, bounds.position.y), bounds.end, Vector2(bounds.position.x, bounds.end.y)]:
		corners.append(Vector3(c.x, 0, c.y))
		corners.append(Vector3(c.x, WALL_TOP, c.y))
	# size with even margins; fit_target() then shifts the view so the floor sits in the clear area
	var mx: float = (fit_margins.left + fit_margins.right) * 0.5
	var my: float = (fit_margins.top + fit_margins.bottom) * 0.5
	var x0: float = vp.x * mx
	var x1: float = vp.x * (1.0 - mx)
	var y0: float = vp.y * my
	var y1: float = vp.y * (1.0 - my)
	var dir := Vector3(cos(p) * sin(y), -sin(p), cos(p) * cos(y))
	for i in 32:
		var d := (lo + hi) * 0.5
		cam.global_position = centre + dir * d
		cam.look_at(centre, Vector3.UP if absf(p) < deg_to_rad(89.5) else Vector3(-sin(y), 0, -cos(y)))
		var fits := true
		for c in corners:
			if cam.is_position_behind(c):
				fits = false
				break
			var s := cam.unproject_position(c)
			if s.x < x0 or s.x > x1 or s.y < y0 or s.y > y1:
				fits = false
				break
		if fits:
			hi = d
		else:
			lo = d
	cam.global_transform = keep
	return maxf(hi, 3.0)


## Look-at point that puts the floor's centre in the middle of the clear area (right of the palette, below the
## toolbar) at distance d, pitch p, yaw y.
func fit_target(d: float, p: float = NAN, y: float = NAN) -> Vector3:
	if is_nan(p):
		p = pitch
	if is_nan(y):
		y = yaw
	var vp := get_viewport().get_visible_rect().size
	var centre := Vector3(bounds.get_center().x, 0, bounds.get_center().y)
	var mpp := 2.0 * d * tan(deg_to_rad(cam.fov) / 2.0) / maxf(vp.y, 1.0)  # metres per pixel at the target
	var dx: float = vp.x * (fit_margins.left - fit_margins.right) * 0.5
	var dy: float = vp.y * (fit_margins.top - fit_margins.bottom) * 0.5
	var right := Vector3(cos(y), 0, -sin(y))
	var fwd := Vector3(-sin(y), 0, -cos(y))
	# moving the target left/back moves the floor right/down on screen; a tilted view stretches depth by 1/sin
	return centre - right * dx * mpp + fwd * dy * mpp / maxf(absf(sin(p)), 0.2)


func _on_resize() -> void:
	if is_inside_tree() and cam:
		_refit_home()


## Recompute the home view for the current window and insets; jump there if the user has not moved the view.
func _refit_home() -> void:
	var fit := fit_distance(deg_to_rad(-52.0), deg_to_rad(-30.0))
	max_distance = maxf(fit * 2.5, 30.0)
	_home.target = fit_target(fit, deg_to_rad(-52.0), deg_to_rad(-30.0))
	_home.distance = fit
	if not user_moved and not (_tw and _tw.is_running()):
		jump(_home.target, _home.distance, _home.pitch, _home.yaw)


func set_insets(left: float, right: float, top: float, bottom: float) -> void:
	insets_px = {"left": maxf(left, 0.0), "right": maxf(right, 0.0), "top": maxf(top, 0.0), "bottom": maxf(bottom, 0.0)}
	_refit_home()


func _apply() -> void:
	pitch = clampf(pitch, deg_to_rad(PITCH_MIN), deg_to_rad(PITCH_MAX))
	distance = clampf(distance, MIN_DISTANCE, max_distance)
	var dir := Vector3(cos(pitch) * sin(yaw), -sin(pitch), cos(pitch) * cos(yaw))
	cam.global_position = target + dir * distance
	cam.look_at(target, Vector3.UP if absf(pitch) < deg_to_rad(89.5) else Vector3(-sin(yaw), 0, -cos(yaw)))


func _clamp_target(t: Vector3) -> Vector3:
	var b := bounds.grow(maxf(bounds.size.length() * 0.25, 4.0))
	return Vector3(clampf(t.x, b.position.x, b.end.x), t.y, clampf(t.z, b.position.y, b.end.y))


func _process(delta: float) -> void:
	if _tw and _tw.is_running():
		return
	if _keys != Vector3.ZERO:
		_pan_world(Vector2(_keys.x, _keys.z) * distance * 0.9 * delta)
	var a := 1.0 - exp(-12.0 * delta)
	var moved := absf(distance - _goal_distance) > 0.001 or target.distance_to(_goal_target) > 0.0005
	if moved:
		distance = lerpf(distance, _goal_distance, a)
		target = target.lerp(_goal_target, a)
		_apply()


func fly_to(new_target: Vector3, new_distance: float, new_pitch := NAN, new_yaw := NAN, secs := 0.9) -> void:
	if _tw:
		_tw.kill()
	new_distance = clampf(new_distance, MIN_DISTANCE, max_distance)
	_goal_distance = new_distance
	_goal_target = new_target
	_tw = create_tween().set_parallel().set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN_OUT)
	_tw.tween_property(self, "target", new_target, secs)
	_tw.tween_property(self, "distance", new_distance, secs)
	if not is_nan(new_pitch):
		_tw.tween_property(self, "pitch", new_pitch, secs)
	if not is_nan(new_yaw):
		# shortest way round
		var y := yaw + wrapf(new_yaw - yaw, -PI, PI)
		_tw.tween_property(self, "yaw", y, secs)
	_tw.tween_method(func(_v): _apply(), 0.0, 1.0, secs)


var home_target: Vector3:
	get: return _home.target
var home_distance: float:
	get: return _home.distance


## Kept for callers that only know a centre and a distance.
func set_home(t: Vector3, d: float) -> void:
	_home.target = t
	_home.distance = d
	max_distance = maxf(max_distance, d * 2.0)
	jump(t, d, _home.pitch, _home.yaw)


func jump(t: Vector3, d: float, p: float, y: float) -> void:
	if _tw:
		_tw.kill()
	target = t
	distance = clampf(d, MIN_DISTANCE, max_distance)
	pitch = p
	yaw = y
	_goal_target = target
	_goal_distance = distance
	_apply()


func reset(secs := 0.9) -> void:
	user_moved = false
	fly_to(_home.target, _home.distance, _home.pitch, _home.yaw, secs)


# ---------------------------------------------------------------- commands (toolbar, keys, host page)

## Fit the whole floor in view, keeping the current angle.
func fit(secs := 0.7) -> void:
	var d := fit_distance()
	fly_to(fit_target(d), d, NAN, NAN, secs)


func zoom_step(steps: float) -> void:
	user_moved = true
	if _tw and _tw.is_running():
		_tw.kill()
		_goal_distance = distance
		_goal_target = target
	_goal_distance = clampf(_goal_distance * pow(0.8, steps), MIN_DISTANCE, max_distance)


func rotate_step(degrees: float, secs := 0.5) -> void:
	user_moved = true
	fly_to(_goal_target if not (_tw and _tw.is_running()) else target, distance, NAN, yaw + deg_to_rad(degrees), secs)


## Top view (plan view, north up) or back to the 3D angle.
func top_view(on: bool, secs := 0.7) -> void:
	user_moved = on
	var p := deg_to_rad(PITCH_MIN + 0.5) if on else deg_to_rad(-52.0)
	var y := 0.0 if on else deg_to_rad(-30.0)
	var d := fit_distance(p, y)
	fly_to(fit_target(d, p, y), d, p, y, secs)


var is_top: bool:
	get: return pitch < deg_to_rad(-80.0)


func command(action: String) -> void:
	match action:
		"zoomIn": zoom_step(1.0)
		"zoomOut": zoom_step(-1.0)
		"fit": fit()
		"reset": reset()
		"top": top_view(true)
		"perspective": top_view(false)
		"toggleTop": top_view(not is_top)
		"rotateLeft": rotate_step(-45.0)
		"rotateRight": rotate_step(45.0)


# ---------------------------------------------------------------- input

## Where a screen point meets the floor (y = 0), or null when it points at the sky.
func ground_at(screen: Vector2) -> Variant:
	var o := cam.project_ray_origin(screen)
	var d := cam.project_ray_normal(screen)
	if absf(d.y) < 1e-4:
		return null
	var k := -o.y / d.y
	return o + d * k if k > 0.0 else null


func _zoom_at(screen: Vector2, factor: float) -> void:
	user_moved = true
	if _tw and _tw.is_running():
		_tw.kill()
		_goal_distance = distance
		_goal_target = target
	var new_d := clampf(_goal_distance * factor, MIN_DISTANCE, max_distance)
	var real := new_d / _goal_distance
	var hit = ground_at(screen)
	if hit != null:
		# keep the point under the cursor in place: move the target toward it as much as the view shrinks
		var h: Vector3 = hit
		_goal_target = _clamp_target(_goal_target + (Vector3(h.x, 0, h.z) - _goal_target) * (1.0 - real))
	_goal_distance = new_d


func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventMouseButton:
		if e.button_index == MOUSE_BUTTON_WHEEL_UP and e.pressed:
			_zoom_at(e.position, 0.85 if not e.ctrl_pressed else 0.95)
		elif e.button_index == MOUSE_BUTTON_WHEEL_DOWN and e.pressed:
			_zoom_at(e.position, 1.0 / 0.85 if not e.ctrl_pressed else 1.0 / 0.95)
		elif e.button_index in [MOUSE_BUTTON_LEFT, MOUSE_BUTTON_RIGHT, MOUSE_BUTTON_MIDDLE]:
			if e.pressed:
				_drag = e.button_index
				drag_px = 0.0
				if e.double_click and e.button_index == MOUSE_BUTTON_LEFT:
					var hit = ground_at(e.position)
					if hit != null:
						var h: Vector3 = hit
						fly_to(_clamp_target(Vector3(h.x, 0, h.z)), maxf(distance * 0.55, 3.0), NAN, NAN, 0.6)
			else:
				_drag = 0
	elif e is InputEventMagnifyGesture:
		_zoom_at(e.position, 1.0 / e.factor)
	elif e is InputEventPanGesture:
		_pan(e.delta * 12.0)
	elif e is InputEventMouseMotion and _drag != 0:
		drag_px += e.relative.length()
		if _drag == MOUSE_BUTTON_LEFT and not e.shift_pressed:
			_orbit(e.relative)
		else:
			_pan(e.relative)
	elif e is InputEventScreenTouch:
		if e.pressed:
			_touches[e.index] = e.position
		else:
			_touches.erase(e.index)
		_pinch = 0.0
	elif e is InputEventScreenDrag:
		_touches[e.index] = e.position
		if _touches.size() == 1:
			_orbit(e.relative)
		elif _touches.size() == 2:
			var p: Array = _touches.values()
			var d: float = (p[0] as Vector2).distance_to(p[1])
			if _pinch > 0.0 and d > 1.0:
				_zoom_at(((p[0] as Vector2) + (p[1] as Vector2)) * 0.5, _pinch / d)
			_pinch = d
			_pan(e.relative * 0.5)
	elif e is InputEventKey and not e.echo:
		_key(e)


func _key(e: InputEventKey) -> void:
	var on := 1.0 if e.pressed else 0.0
	match e.keycode:
		KEY_LEFT, KEY_A: _keys.x = -on
		KEY_RIGHT, KEY_D: _keys.x = on
		KEY_UP, KEY_W: _keys.z = -on
		KEY_DOWN, KEY_S: _keys.z = on
	if not e.pressed:
		return
	match e.keycode:
		KEY_EQUAL, KEY_PLUS, KEY_KP_ADD: zoom_step(1.0)
		KEY_MINUS, KEY_KP_SUBTRACT: zoom_step(-1.0)
		KEY_Q: rotate_step(-45.0)
		KEY_E: rotate_step(45.0)
		KEY_F: fit()
		KEY_T: top_view(not is_top)
		KEY_HOME: reset()


func _orbit(rel: Vector2) -> void:
	user_moved = true
	if _tw and _tw.is_running():
		_tw.kill()
		_goal_distance = distance
		_goal_target = target
	yaw -= rel.x * 0.006
	pitch -= rel.y * 0.006
	_apply()


## Pan by screen pixels: the point under the cursor follows it at any zoom.
func _pan(rel: Vector2) -> void:
	var vp := get_viewport().get_visible_rect().size
	var metres_per_px := 2.0 * distance * tan(deg_to_rad(cam.fov) / 2.0) / maxf(vp.y, 1.0)
	_pan_world(rel * metres_per_px * Vector2(-1, -1))


## Move the view by (right, forward) metres on the ground.
func _pan_world(v: Vector2) -> void:
	user_moved = true
	if _tw and _tw.is_running():
		_tw.kill()
		_goal_distance = distance
	var right := Vector3(cos(yaw), 0, -sin(yaw))
	var fwd := Vector3(-sin(yaw), 0, -cos(yaw))
	_goal_target = _clamp_target(_goal_target + right * v.x - fwd * v.y)
	target = _goal_target
	_apply()
